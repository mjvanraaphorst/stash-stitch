import { makeTimeline, locate } from './timeline.js';
import { mediaURL } from './mp4.js';

// One native Video.js tech remains on screen, so its controls and fullscreen
// continue to work when mixed-format chapters require source switching.
export class NativeCompatibility {
  constructor(video, scenes, groupId) {
    this.video = video;
    this.timeline = makeTimeline(scenes, groupId);
    this.chapterIndex = 0;
    this.preload = document.createElement('video');
    this.preload.preload = 'auto';
    this.abort = new AbortController();
    this.generation = 0;
    this.ended = () => {
      if (this.chapterIndex + 1 < this.timeline.chapters.length) this.seek(this.timeline.chapters[this.chapterIndex + 1].start, true).catch(e => this.onError?.(e));
    };
    video.addEventListener('ended', this.ended);
  }
  async open() { await this.seek(0, false); return this.timeline; }
  url(scene) {
    const stream = scene.sceneStreams?.find(s => s.mime_type && this.video.canPlayType(s.mime_type));
    return mediaURL(stream?.url || scene.paths.stream);
  }
  async seek(seconds, play = !this.video.paused) {
    const generation = ++this.generation;
    const { chapterIndex, localTime } = locate(this.timeline, seconds);
    const target = this.timeline.chapters[chapterIndex];
    const url = this.url(target.scene);
    this.video.pause();
    if (this.video.src !== url) {
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer);
          this.video.removeEventListener('loadedmetadata', ready);
          this.video.removeEventListener('error', failed);
          this.abort.signal.removeEventListener('abort', aborted);
          error ? reject(error) : resolve();
        };
        const ready = () => finish();
        const failed = () => finish(new Error('This chapter could not play. Open the original scene to check its available streams.'));
        const aborted = () => finish(new DOMException('Aborted', 'AbortError'));
        const timer = setTimeout(() => finish(new Error('Chapter loading timed out.')), 30000);
        this.video.addEventListener('loadedmetadata', ready, { once: true });
        this.video.addEventListener('error', failed, { once: true });
        this.abort.signal.addEventListener('abort', aborted, { once: true });
        this.video.src = url;
        this.video.load();
      });
    }
    if (generation !== this.generation || this.abort.signal.aborted) return;
    this.chapterIndex = chapterIndex;
    this.video.currentTime = Math.min(localTime, Math.max(0, this.video.duration - 0.01));
    if (play) await this.video.play();
    const next = this.timeline.chapters[chapterIndex + 1];
    if (next) this.preload.src = this.url(next.scene);
  }
  currentTime() { return this.timeline.chapters[this.chapterIndex].start + this.video.currentTime; }
  buffered() {
    const offset = this.timeline.chapters[this.chapterIndex].start;
    return Array.from({ length: this.video.buffered.length }, (_, i) => [offset + this.video.buffered.start(i), offset + this.video.buffered.end(i)]);
  }
  destroy() {
    this.abort.abort(); this.generation++;
    this.video.removeEventListener('ended', this.ended);
    for (const video of [this.video, this.preload]) { video.pause(); video.removeAttribute('src'); video.load(); }
  }
}
