import { Mp4Asset, mediaURL } from './mp4.js';
import { makeTimeline, locate } from './timeline.js';

function sourceEvent(target, success, signal, action) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Media operation timed out.')), 30000);
    const finish = error => {
      clearTimeout(timeout);
      target.removeEventListener(success, done);
      target.removeEventListener('error', failed);
      signal?.removeEventListener('abort', aborted);
      error ? reject(error) : resolve();
    };
    const done = () => finish();
    const failed = () => finish(new Error('The browser rejected this media stream. Try compatibility mode.'));
    const aborted = () => finish(new DOMException('Aborted', 'AbortError'));
    target.addEventListener(success, done, { once: true });
    target.addEventListener('error', failed, { once: true });
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) return aborted();
    try { action?.(); } catch (error) { finish(error); }
  });
}

export function directURL(scene) {
  const stream = scene.sceneStreams?.find(s => s.mime_type === 'video/mp4' && /direct/i.test(s.label || ''));
  return mediaURL(stream?.url || scene.paths.stream);
}

export class ContinuousPlayer {
  constructor(video, scenes, groupId, notify = () => {}) {
    this.video = video;
    this.scenes = scenes;
    this.groupId = groupId;
    this.notify = notify;
    this.abort = new AbortController();
    this.loaded = new Map();
    this.assets = [];
    this.bufferBytes = 0;
    this.preloadLimit = 64 * 1024 * 1024;
  }

  async open() {
    const MS = window.MediaSource || window.ManagedMediaSource;
    if (!MS) throw new Error('Continuous playback is not supported by this browser. Try compatibility mode.');
    const ordered = makeTimeline(this.scenes, this.groupId);
    for (const [i, chapter] of ordered.chapters.entries()) {
      this.notify({ status: `Reading chapter ${i + 1} of ${ordered.chapters.length}…` });
      const asset = await new Mp4Asset(directURL(chapter.scene), this.abort.signal).open();
      if (i && asset.signature() !== this.assets[0].signature()) throw new Error('These chapters have different media formats. Use compatibility mode for this group.');
      this.assets.push(asset);
    }
    this.timeline = makeTimeline(ordered.chapters.map((c, i) => ({ ...c.scene, duration: this.assets[i].duration })), this.groupId);
    this.source = new MS();
    this.objectURL = URL.createObjectURL(this.source);
    this.video.disableRemotePlayback = true;
    await sourceEvent(this.source, 'sourceopen', this.abort.signal, () => { this.video.src = this.objectURL; });
    this.buffers = this.assets[0].tracks.map(track => this.source.addSourceBuffer(track.mime));
    this.source.duration = this.timeline.duration;
    this.timer = setInterval(() => this.pump(), 400);
    this.onSeek = () => this.pump();
    this.video.addEventListener('seeking', this.onSeek);
    this.video.addEventListener('error', this.onMediaError = () => this.fail(new Error('The browser could not decode this group. Try compatibility mode.')));
    await this.pump(true);
    this.notify({ status: 'Continuous playback', timeline: this.timeline });
    return this.timeline;
  }

  async append(chapterIndex, segment) {
    const asset = this.assets[chapterIndex];
    const chapter = this.timeline.chapters[chapterIndex];
    const fragments = await asset.fragment(segment);
    let bytes = 0;
    for (const { track, buffer } of fragments) {
      const index = asset.tracks.indexOf(track);
      const sb = this.buffers[index];
      sb.timestampOffset = chapter.start - track.trim;
      // Reset first, so backwards chapter seeks don't violate append window bounds.
      sb.appendWindowStart = 0;
      sb.appendWindowEnd = chapter.end;
      // Chromium rounds decode timestamps to microseconds. A keyframe a fraction
      // below the chapter boundary would otherwise discard the entire first GOP.
      sb.appendWindowStart = Math.max(0, chapter.start - 0.002);
      await sourceEvent(sb, 'updateend', this.abort.signal, () => sb.appendBuffer(track.init));
      await sourceEvent(sb, 'updateend', this.abort.signal, () => sb.appendBuffer(buffer));
      bytes += buffer.byteLength;
    }
    this.loaded.set(`${chapterIndex}:${segment.index}`, { start: chapter.start + segment.start, end: chapter.start + segment.end, bytes });
    this.bufferBytes += bytes;
    if (chapterIndex === this.assets.length - 1 && segment.index === asset.segments.length - 1 && this.source.readyState === 'open') this.source.endOfStream();
  }

  async evict() {
    // Retain chapter openings, and a rolling window around playback. Account for
    // byte quota as well as duration, including backwards and distant seeks.
    const now = this.video.currentTime;
    const candidates = [...this.loaded.entries()].filter(([key, value]) => (value.end < now - 45 || value.start > now + 90) && (Number(key.split(':')[1]) > 2 || this.bufferBytes > this.preloadLimit));
    for (const [key, value] of candidates) {
      for (const sb of this.buffers) await sourceEvent(sb, 'updateend', this.abort.signal, () => sb.remove(value.start, value.end));
      this.loaded.delete(key);
      this.bufferBytes -= value.bytes;
    }
  }

  async pump(initial = false) {
    if (this.busy || this.abort.signal.aborted || this.failed) return;
    this.busy = true;
    try {
      // Browsers can independently evict SourceBuffer data under memory pressure.
      // Do not let our bookkeeping prevent a later seek from refetching it.
      const ranges = this.buffered();
      for (const [key, value] of this.loaded) {
        const margin = Math.min(0.1, (value.end - value.start) / 4);
        if (!ranges.some(([a, b]) => a <= value.start + margin && b >= value.end - margin)) {
          this.loaded.delete(key);
          this.bufferBytes -= value.bytes;
        }
      }
      await this.evict();
      const now = this.video.currentTime;
      const { chapterIndex, localTime } = locate(this.timeline, now);
      const requests = [];
      const add = (i, from, until) => this.assets[i]?.segments.forEach(s => {
        if (s.end > from && s.start < until && !this.loaded.has(`${i}:${s.index}`)) requests.push([i, s]);
      });
      // Playback and seeking take priority over speculative chapter starts.
      add(chapterIndex, localTime, localTime + 25);
      const chapter = this.timeline.chapters[chapterIndex];
      if (chapter.end - now < 25) add(chapterIndex + 1, 0, 25 - (chapter.end - now));
      if (!requests.length && this.bufferBytes < this.preloadLimit) {
        for (let i = 0; i < this.assets.length; i++) add(i, 0, 5);
      }
      // Yield after one fragment so a new seek can change priorities immediately.
      if (requests.length) {
        const [i, segment] = requests[0];
        await this.append(i, segment);
        const openings = this.assets.filter((asset, chapterIndex) => asset.segments.filter(s => s.start < 5).every(s => this.loaded.has(`${chapterIndex}:${s.index}`))).length;
        this.notify({ buffered: this.buffered(), status: `Continuous playback · ${openings}/${this.assets.length} chapter openings prepared` });
      }
      // A later seek or speculative append reopens an ended MediaSource. The
      // final fragment may already be loaded, so it won't be appended again to
      // re-signal EOS. Finalize after every batch while that fragment is present.
      const finalIndex = this.assets.length - 1;
      const finalSegment = this.assets[finalIndex].segments.at(-1);
      if (this.source.readyState === 'open' && this.loaded.has(`${finalIndex}:${finalSegment.index}`)) this.source.endOfStream();
      if (initial && !this.loaded.size) throw new Error('No playable chapter data was found.');
    } catch (error) {
      if (initial) throw error;
      this.fail(error);
    } finally { this.busy = false; }
  }

  buffered() {
    const ranges = this.video.buffered;
    return Array.from({ length: ranges.length }, (_, i) => [ranges.start(i), ranges.end(i)]);
  }
  fail(error) {
    if (this.abort.signal.aborted || this.failed) return;
    this.failed = true;
    clearInterval(this.timer);
    this.video.pause();
    this.notify({ error: error.message });
  }
  currentTime() { return this.video.currentTime; }
  seek(time) { this.video.currentTime = locate(this.timeline, time).time; }
  play() { return this.video.play(); }
  pause() { this.video.pause(); }
  destroy() {
    this.abort.abort();
    clearInterval(this.timer);
    this.video.removeEventListener('seeking', this.onSeek);
    this.video.removeEventListener('error', this.onMediaError);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
    this.assets.length = 0;
  }
}

// Best-effort transitions for mixed formats. Keep two decoded media elements;
// switching src on the same element would discard its prepared buffer.
export class CompatibilityPlayer {
  constructor(videos, scenes, groupId, notify = () => {}) {
    this.videos = videos;
    this.notify = notify;
    this.timeline = makeTimeline(scenes, groupId);
    this.active = 0;
    this.chapterIndex = 0;
    this.generation = 0;
    this.abort = new AbortController();
  }
  async open() {
    for (const v of this.videos) {
      v.preload = 'auto';
      v.playsInline = true;
      v.addEventListener('ended', this.onEnded = this.onEnded || (() => {
        if (this.chapterIndex < this.timeline.chapters.length - 1) this.seek(this.timeline.chapters[this.chapterIndex + 1].start, true).catch(e => this.notify({ error: e.message }));
      }));
      v.addEventListener('error', this.onError = this.onError || (() => this.notify({ error: 'A scene could not play in compatibility mode. Open its original Stash player to check available streams.' })));
    }
    await this.seek(0, false);
    this.notify({ status: 'Compatibility playback · transitions may briefly pause', timeline: this.timeline });
    return this.timeline;
  }
  url(scene) {
    const probe = this.videos[0];
    const native = scene.sceneStreams?.find(s => s.mime_type && probe.canPlayType(s.mime_type));
    return mediaURL(native?.url || scene.paths.stream);
  }
  prepare(slot, chapterIndex) {
    const chapter = this.timeline.chapters[chapterIndex];
    if (!chapter) return;
    const v = this.videos[slot];
    if (v.dataset.chapter !== String(chapterIndex)) {
      v.dataset.chapter = String(chapterIndex);
      v.src = this.url(chapter.scene);
      v.load();
    }
    return v;
  }
  async seek(seconds, autoplay = !this.videos[this.active].paused) {
    const generation = ++this.generation;
    const { chapterIndex, localTime } = locate(this.timeline, seconds);
    const prepared = this.videos.findIndex(v => v.dataset.chapter === String(chapterIndex));
    const slot = prepared >= 0 ? prepared : 1 - this.active;
    this.videos[this.active].pause();
    const target = this.prepare(slot, chapterIndex);
    if (target.readyState < 1) await sourceEvent(target, 'loadedmetadata', this.abort.signal);
    if (generation !== this.generation || this.abort.signal.aborted) return;
    target.currentTime = Math.min(localTime, Math.max(0, target.duration - 0.01));
    this.active = slot;
    this.chapterIndex = chapterIndex;
    this.videos.forEach((v, i) => { v.hidden = i !== slot; });
    this.notify({ active: slot });
    if (autoplay) await target.play();
    this.prepare(1 - slot, chapterIndex + 1);
  }
  currentTime() { return this.timeline.chapters[this.chapterIndex].start + this.videos[this.active].currentTime; }
  play() { return this.videos[this.active].play(); }
  pause() { this.videos[this.active].pause(); }
  destroy() {
    this.abort.abort(); this.generation++;
    for (const v of this.videos) { v.removeEventListener('ended', this.onEnded); v.removeEventListener('error', this.onError); v.pause(); v.removeAttribute('src'); v.load(); delete v.dataset.chapter; }
  }
}
