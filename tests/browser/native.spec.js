import { test, expect } from '@playwright/test';

test('native Video.js controls expose and seek the full group timeline', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/native/group/1');
  await expect(page.getByRole('status')).toContainText('Continuous playback', { timeout: 20000 });
  await expect.poll(() => page.evaluate(() => window.stitchTest.getPlayer()?.duration())).toBe(24);
  await expect.poll(() => page.locator('video').first().evaluate(v => [0.1, 8.1, 16.1].every(t => Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]).some(([a,b]) => a <= t && t < b))), { timeout: 20000 }).toBe(true);
  await expect(page.getByLabel('Group chapters').getByRole('button')).toHaveCount(3);
  await expect(page.getByLabel('Group chapters').getByRole('button').nth(1)).toBeEnabled();
  await page.getByLabel('Group chapters').getByRole('button').nth(1).click();
  await expect.poll(() => page.evaluate(() => window.stitchTest.getPlayer().currentTime())).toBeGreaterThan(7.9);
  await page.evaluate(() => window.stitchTest.getPlayer().play());
  await expect.poll(() => page.evaluate(() => window.stitchTest.getPlayer().currentTime()), { timeout: 10000 }).toBeGreaterThan(9);
  await page.evaluate(() => { const p = window.stitchTest.getPlayer(); p.pause(); p.currentTime(18); });
  await expect.poll(() => page.evaluate(() => window.stitchTest.getPlayer().currentTime())).toBeGreaterThan(17.9);
  await page.evaluate(() => window.stitchTest.getPlayer().currentTime(2));
  await expect.poll(() => page.evaluate(() => window.stitchTest.getPlayer().currentTime())).toBeLessThan(3);
  await page.evaluate(() => { const p = window.stitchTest.getPlayer(); p.currentTime(23); p.play(); });
  await expect.poll(() => page.locator('video').first().evaluate(v => v.ended), { timeout: 15000 }).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('leading empty MP4 edits fall back automatically and preserve combined seeking', async ({ page }) => {
  await page.goto('/native/group/4');
  await expect(page.getByRole('status')).toContainText('Compatibility playback', { timeout: 20000 });
  await expect(page.getByLabel('Group chapters').getByRole('button').first()).toBeEnabled();
  await page.evaluate(() => window.stitchTest.getPlayer().play());
  await expect.poll(() => page.evaluate(() => window.stitchTest.getPlayer().currentTime()), { timeout: 10000 }).toBeGreaterThan(0.5);
  await page.evaluate(() => { const p = window.stitchTest.getPlayer(); p.pause(); p.currentTime(10); });
  await expect.poll(() => page.evaluate(() => window.stitchTest.getPlayer().currentTime()), { timeout: 10000 }).toBeGreaterThan(9.9);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('native player refetches evicted media after backwards seeking', async ({ page }) => {
  await page.goto('/native/group/3');
  await expect(page.getByLabel('Group chapters').getByRole('button').first()).toBeEnabled({ timeout: 20000 });
  const bufferedAt = t => page.locator('video').first().evaluate((v, time) => Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]).some(([a,b]) => a <= time && time < b), t);
  await expect.poll(() => bufferedAt(20), { timeout: 15000 }).toBe(true);
  await page.evaluate(() => window.stitchTest.getPlayer().currentTime(100));
  await expect.poll(() => bufferedAt(101), { timeout: 15000 }).toBe(true);
  await expect.poll(() => bufferedAt(20), { timeout: 15000 }).toBe(false);
  await page.evaluate(() => window.stitchTest.getPlayer().currentTime(20));
  await expect.poll(() => bufferedAt(20.1), { timeout: 15000 }).toBe(true);
});

test('native compatibility playback switches chapters and keeps the global controls', async ({ page }) => {
  await page.goto('/native/group/2');
  await expect(page.getByRole('status')).toContainText('Compatibility playback', { timeout: 20000 });
  await expect.poll(() => page.evaluate(() => window.stitchTest.getPlayer()?.duration())).toBe(16);
  await page.getByLabel('Group chapters').getByRole('button').nth(1).click();
  await expect.poll(() => page.evaluate(() => window.stitchTest.getPlayer().currentTime()), { timeout: 10000 }).toBeGreaterThan(7.9);
  await page.evaluate(() => window.stitchTest.getPlayer().currentTime(11));
  await expect.poll(() => page.locator('video').first().evaluate(v => v.currentTime)).toBeGreaterThan(2.9);
  await expect.poll(() => page.evaluate(() => window.stitchTest.getPlayer().currentTime())).toBeGreaterThan(10.9);
  await page.evaluate(() => window.stitchTest.getPlayer().currentTime(1));
  await expect.poll(() => page.evaluate(() => window.stitchTest.getPlayer().currentTime())).toBeLessThan(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
