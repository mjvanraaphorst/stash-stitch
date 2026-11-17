export function makeTimeline(scenes, groupId) {
  const ordered = [...scenes].sort((a, b) => {
    const index = s => s.groups?.find(g => String(g.group.id) === String(groupId))?.scene_index;
    return (index(a) ?? Infinity) - (index(b) ?? Infinity) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  });
  let duration = 0;
  const chapters = ordered.map(scene => {
    const length = Number(scene.duration ?? scene.files?.[0]?.duration);
    if (!Number.isFinite(length) || length <= 0) throw new Error(`Scene ${scene.title || scene.id} has no usable duration.`);
    const chapter = { scene, start: duration, duration: length, end: duration + length };
    duration += length;
    return chapter;
  });
  return { chapters, duration };
}

export function locate(timeline, seconds) {
  const time = Math.max(0, Math.min(Number(seconds) || 0, timeline.duration));
  const index = timeline.chapters.findIndex(c => time < c.end);
  const chapterIndex = index < 0 ? timeline.chapters.length - 1 : index;
  const chapter = timeline.chapters[chapterIndex];
  return { chapter, chapterIndex, localTime: chapter ? time - chapter.start : 0, time };
}

export function clock(seconds) {
  const n = Math.max(0, Math.floor(seconds || 0));
  return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
