import { test, expect } from '@playwright/test';

test('group cards, metadata and ungrouped library', async ({ page }) => {
  await page.goto('/plugins/stash-stitch');
  await expect(page.getByRole('heading', { name: 'A story in three chapters' })).toBeVisible();
  await page.getByRole('button', { name: 'Ungrouped scenes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Different resolution' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('continuous timeline preloads chapter starts, crosses joins, seeks backwards and reaches final chapter', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/plugins/stash-stitch/group/1');
  await page.getByRole('button', { name: 'Prepare playback' }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const video = page.locator('video').first();
  await expect.poll(() => video.evaluate(v => v.duration)).toBe(24);
  // All three openings must be inside the actual video element buffer.
  await expect.poll(() => video.evaluate(v => [0.1, 8.1, 16.1].every(t => Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]).some(([a,b]) => t >= a && t < b))), { timeout: 20000 }).toBe(true);
  await page.getByRole('slider', { name: 'Combined timeline' }).fill('7');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => video.evaluate(v => v.currentTime), { timeout: 15000 }).toBeGreaterThan(9);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('slider', { name: 'Combined timeline' }).fill('18');
  await expect.poll(() => video.evaluate(v => v.currentTime)).toBeGreaterThan(17.9);
  await page.getByRole('slider', { name: 'Combined timeline' }).fill('2');
  await expect.poll(() => video.evaluate(v => v.currentTime)).toBeLessThan(3);
  await page.getByRole('slider', { name: 'Combined timeline' }).fill('23');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => video.evaluate(v => v.ended), { timeout: 15000 }).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('mixed media has an explicit fallback with a working combined seek bar', async ({ page }) => {
  await page.goto('/plugins/stash-stitch/group/2');
  await page.getByRole('button', { name: 'Prepare playback' }).click();
  await expect(page.getByRole('alert')).toContainText('different media formats');
  await page.getByRole('alert').getByRole('button', { name: 'Use compatibility mode' }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await page.getByRole('slider', { name: 'Combined timeline' }).fill('11');
  await expect.poll(() => page.locator('video:not([hidden])').evaluate(v => v.currentTime)).toBeGreaterThan(2.9);
  await page.getByRole('slider', { name: 'Combined timeline' }).fill('1');
  await expect.poll(() => page.locator('video:not([hidden])').evaluate(v => v.currentTime)).toBeLessThan(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('distant seeks evict old fragments and backwards seeks refetch them', async ({ page }) => {
  await page.goto('/plugins/stash-stitch/group/3');
  await page.getByRole('button', { name: 'Prepare playback' }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  const video = page.locator('video').first();
  const timeline = page.getByRole('slider', { name: 'Combined timeline' });
  const bufferedAt = t => video.evaluate((v, time) => Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]).some(([a,b]) => time >= a && time < b), t);
  await expect.poll(() => bufferedAt(20), { timeout: 15000 }).toBe(true);
  await timeline.fill('100');
  await expect.poll(() => bufferedAt(101), { timeout: 15000 }).toBe(true);
  await expect.poll(() => bufferedAt(20), { timeout: 15000 }).toBe(false);
  await timeline.fill('20');
  await expect.poll(() => bufferedAt(20.1), { timeout: 15000 }).toBe(true);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => video.evaluate(v => v.currentTime), { timeout: 10000 }).toBeGreaterThan(21);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
