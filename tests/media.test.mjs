import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaURL, readRange } from '../src/mp4.js';
test('media requests stay on the Stash origin, including reverse-proxy paths', () => {
  assert.equal(mediaURL('/stash/scene/1/stream', 'https://stash.example/stash/'), 'https://stash.example/stash/scene/1/stream');
  assert.throws(() => mediaURL('https://other.example/video.mp4', 'https://stash.example/'));
  assert.throws(() => mediaURL('javascript:alert(1)', 'https://stash.example/'));
});
test('byte-range reads reject full-file responses and invalid ranges', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, range] of [[200, ''], [206, 'bytes 1-3/10'], [206, 'bytes 0-9/10']]) {
      globalThis.fetch = async () => new Response(new Uint8Array(4), { status, headers: { 'Content-Range': range } });
      await assert.rejects(readRange('https://stash.example/scene/1/stream', 0, 3), /byte-range/);
    }
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.headers.Range, 'bytes=0-3');
      assert.equal(options.redirect, 'error');
      return new Response(new Uint8Array(4), { status: 206, headers: { 'Content-Range': 'bytes 0-3/10' } });
    };
    const result = await readRange('https://stash.example/scene/1/stream', 0, 3);
    assert.equal(result.size, 10);
    assert.equal(result.buffer.fileStart, 0);
  } finally { globalThis.fetch = original; }
});
