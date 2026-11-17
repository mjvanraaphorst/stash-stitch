import { makeTimeline } from './timeline.js';

export function groupCatalog(groups) {
  const byScene = new Map(), byGroup = new Map(), hidden = new Set();
  for (const group of [...groups].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))) {
    if (group.scenes.length < 2) continue;
    const chapters = makeTimeline(group.scenes, group.id).chapters;
    // A scene can belong to several groups. One deterministic ownership avoids
    // duplicate cards or two virtual cards sharing the same native scene ID.
    if (chapters.some(c => byScene.has(c.scene.id))) continue;
    const entry = { ...group, representative: chapters[0].scene.id, duration: chapters.at(-1).end };
    byGroup.set(group.id, entry);
    for (const chapter of chapters) {
      byScene.set(chapter.scene.id, entry);
      if (chapter.scene.id !== entry.representative) hidden.add(chapter.scene.id);
    }
  }
  return { byScene, byGroup, hidden };
}

export function anyIds(ids) {
  return ids.reduceRight((next, id) => ({ id: { value: Number(id), modifier: 'EQUALS' }, ...(next ? { OR: next } : {}) }), undefined);
}

export function groupedFilter(filter, catalog) {
  if (!catalog.hidden.size) return filter;
  // Stash permits only one boolean operator per input node. Prefix ordinary ID
  // inequalities, leaving the caller's complete filter intact at the tail.
  return [...catalog.hidden].reduceRight((next, id) => ({ id: { value: Number(id), modifier: 'NOT_EQUALS' }, AND: next }), filter || {});
}

export function groupScene(scene, group) {
  return {
    ...scene, title: group.name, details: group.synopsis || '',
    paths: { ...scene.paths, screenshot: group.front_image_path || scene.paths.screenshot, preview: null, vtt: null, sprite: null },
    files: scene.files.length ? [{ ...scene.files[0], duration: group.duration }] : [],
    __stitchGroup: group.id, __stitchChapters: group.scenes.length,
  };
}
