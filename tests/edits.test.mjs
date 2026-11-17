import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editTiming } from '../src/edits.js';
const edit = (media_time, segment_duration, rate = 1) => ({ media_time, segment_duration, media_rate_integer: rate, media_rate_fraction: 0 });
test('leading empty edits use the movie timescale and preserve media delay', () => {
  const result = editTiming([edit(-1, 120), edit(1024, 8000)], 48000, 1000);
  assert.ok(Math.abs(result.trim - (1024 / 48000 - 0.12)) < 1e-8);
  assert.equal(result.duration, 8.12);
});
test('ordinary trim, contiguous edits and no edits', () => {
  assert.deepEqual(editTiming([], 48000, 1000), { trim: 0, duration: 0 });
  assert.equal(editTiming([edit(1024, 8000)], 48000, 1000).trim, 1024 / 48000);
  const result = editTiming([edit(0, 2000), edit(96000, 2000)], 48000, 1000);
  assert.equal(result.duration, 4); assert.equal(result.trim, 0);
});
test('unsupported rearrangements and rates are explicitly rejected for fallback', () => {
  assert.throws(() => editTiming([edit(0, 1000), edit(0, 1000)], 48000, 1000), /discontinuous/);
  assert.throws(() => editTiming([edit(0, 1000, 0)], 48000, 1000), /playback-rate/);
});
