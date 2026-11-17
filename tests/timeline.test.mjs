import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTimeline, locate, clock } from '../src/timeline.js';
const scene = (id, index, duration = 600) => ({ id, groups: [{ group: { id: 'g' }, scene_index: index }], files: [{ duration }] });
test('group order, exact boundaries, final frame and out-of-range seeks', () => {
  const timeline = makeTimeline([scene('3', 3), scene('1', 1), scene('2', 2)], 'g');
  assert.deepEqual(timeline.chapters.map(c => c.scene.id), ['1', '2', '3']);
  assert.equal(timeline.duration, 1800);
  assert.equal(locate(timeline, 1380).chapterIndex, 2);
  assert.equal(locate(timeline, 1380).localTime, 180);
  assert.equal(locate(timeline, 600).localTime, 0);
  assert.equal(locate(timeline, 1800).localTime, 600);
  assert.equal(locate(timeline, -10).time, 0);
  assert.equal(locate(timeline, 9999).time, 1800);
});
test('missing and repeated indices use deterministic scene ID ordering', () => {
  const timeline = makeTimeline([scene('10', null), scene('2', null), scene('4', 0), scene('3', 0)], 'g');
  assert.deepEqual(timeline.chapters.map(c => c.scene.id), ['3', '4', '2', '10']);
});
test('rejects invalid chapter lengths rather than silently dropping media', () => {
  for (const duration of [0, -1, NaN, Infinity]) assert.throws(() => makeTimeline([scene('1', 1, duration)], 'g'));
});
test('formats elapsed times', () => { assert.equal(clock(1380), '23:00'); assert.equal(clock(3661), '1:01:01'); });
