import { createFile, Log } from 'mp4box';
Log.setLogLevel(Log.error);

const CHUNK = 1024 * 1024;
// Only same-origin streams: media URLs can contain Stash authentication tokens.
export function mediaURL(value, base = window.location.href) {
  const url = new URL(value, base);
  if (url.origin !== new URL(base).origin || !/^https?:$/.test(url.protocol)) throw new Error('Stitch only loads media from this Stash server.');
  return url.href;
}

export async function readRange(url, start, end, signal) {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, credentials: 'same-origin', signal, redirect: 'error' });
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
  if (response.status !== 206 || !match || Number(match[1]) !== start || Number(match[2]) > end) {
    await response.body?.cancel();
    throw new Error('Continuous mode requires an MP4 stream with byte-range support. Try compatibility mode.');
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== Number(match[2]) - start + 1) throw new Error('Incomplete media response.');
  buffer.fileStart = start;
  return { buffer, size: Number(match[3]) };
}

export class Mp4Asset {
  constructor(url, signal) {
    this.url = mediaURL(url);
    this.signal = signal;
    this.file = createFile(false);
    this.file.onError = () => { this.parseError = new Error('This file could not be parsed as MP4.'); };
  }

  async open() {
    let info, offset = 0, bytes = 0;
    this.file.onReady = data => { info = data; };
    while (!info) {
      if (bytes >= 64 * CHUNK) throw new Error('MP4 metadata exceeds the 64 MB safety limit.');
      const result = await readRange(this.url, offset, offset + CHUNK - 1, this.signal);
      bytes += result.buffer.byteLength;
      this.size = result.size;
      const next = this.file.appendBuffer(result.buffer);
      if (this.parseError) throw this.parseError;
      if (!info && (!Number.isFinite(next) || next <= offset || next >= this.size)) throw new Error('No usable MP4 metadata was found.');
      offset = next;
    }
    if (info.isFragmented || info.videoTracks.length !== 1 || info.audioTracks.length > 1) throw new Error('Continuous mode currently supports ordinary MP4 files with one video and at most one audio track.');
    this.info = info;
    this.duration = info.duration / info.timescale;
    this.tracks = [...info.videoTracks, ...info.audioTracks].map(track => {
      const samples = this.file.getTrackSamplesInfo(track.id);
      const edits = track.edits || [];
      if (edits.length > 1 || edits.some(e => e.media_time < 0 || e.media_rate_integer !== 1)) throw new Error('This MP4 uses an unsupported edit list.');
      const trim = edits[0]?.media_time / track.timescale || 0;
      const type = track.type;
      const mime = `${type}/mp4; codecs="${track.codec}"`;
      const MS = window.MediaSource || window.ManagedMediaSource;
      if (!MS?.isTypeSupported(mime)) throw new Error(`Your browser cannot play ${track.codec} in continuous mode.`);
      const trak = this.file.getTrackById(track.id);
      // Apply edit-list timing ourselves, consistently across browsers.
      trak.boxes = trak.boxes.filter(box => box?.type !== 'edts');
      delete trak.edts;
      this.file.setSegmentOptions(track.id, null, { nbSamples: 1, rapAlignement: false });
      return { ...track, samples, trim, mime };
    });
    this.file.onSegment = () => {};
    const init = this.file.initializeSegmentation('per-track');
    for (const track of this.tracks) track.init = init.find(i => i.id === track.id).buffer;
    // Segments begin on keyframes; audio samples are assigned without duplication.
    const video = this.tracks[0];
    const boundaries = [0];
    let last = 0;
    video.samples.forEach((s, i) => {
      const t = s.cts / s.timescale - video.trim;
      if (i > 0 && s.is_sync && t - last >= 1.5 && t < this.duration) { boundaries.push(t); last = t; }
    });
    boundaries.push(this.duration);
    this.segments = boundaries.slice(0, -1).map((start, i) => ({ start, end: boundaries[i + 1], index: i, tracks: [] }));
    for (const track of this.tracks) {
      let cursor = 0;
      for (const segment of this.segments) {
        const first = cursor;
        // Decode order is used for video; keyframe CTS defines each GOP boundary.
        while (cursor < track.samples.length && (segment.index === this.segments.length - 1 || track.samples[cursor].cts / track.timescale - track.trim < segment.end - 0.00001)) cursor++;
        if (cursor > first) segment.tracks.push({ track, first, last: cursor - 1 });
      }
    }
    return this;
  }

  signature() {
    return JSON.stringify(this.tracks.map(t => [t.type, t.id, t.codec, t.video, t.audio]));
  }

  async fragment(segment) {
    const samples = segment.tracks.flatMap(({ track, first, last }) => track.samples.slice(first, last + 1));
    const start = samples.reduce((n, s) => Math.min(n, s.offset), Infinity);
    const end = samples.reduce((n, s) => Math.max(n, s.offset + s.size), 0) - 1;
    if (end - start > 64 * CHUNK) throw new Error('A chapter segment exceeds the 64 MB safety limit. Try compatibility mode.');
    for (const sample of samples) {
      sample.data = new Uint8Array(sample.size);
      sample.alreadyRead = 0;
      this.file.samplesDataSize += sample.size;
    }
    // Bounded requests; no whole-file downloads or server-side processing.
    for (let offset = start; offset <= end; offset += CHUNK) {
      const { buffer } = await readRange(this.url, offset, Math.min(end, offset + CHUNK - 1), this.signal);
      // Copy indexed sample bytes directly. Parsing a partial mdat again can
      // discard data or retain entire files; the metadata already gives us the
      // exact byte ranges needed for each track.
      for (const sample of samples) {
        const a = Math.max(offset, sample.offset);
        const b = Math.min(offset + buffer.byteLength, sample.offset + sample.size);
        if (a < b) {
          sample.data.set(new Uint8Array(buffer, a - offset, b - a), a - sample.offset);
          sample.alreadyRead += b - a;
        }
      }
    }
    const fragments = segment.tracks.map(({ track, first, last }) => {
      if (track.samples.slice(first, last + 1).some(s => s.alreadyRead !== s.size)) throw new Error('Incomplete sample data.');
      const stream = this.file.createFragment(track.id, first, last);
      if (!stream) throw new Error('Could not assemble a complete media segment.');
      return { track, buffer: stream.buffer };
    });
    for (const { track, first, last } of segment.tracks) {
      for (let i = first; i <= last; i++) this.file.releaseSample(this.file.getTrackById(track.id), i);
    }
    this.file.stream.cleanBuffers();
    return fragments;
  }
}
