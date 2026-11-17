import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('all shipped selectors are scoped to Stitch and cannot restyle ordinary players', () => {
  const css = readFileSync(new URL('../plugin/stash-stitch.css', import.meta.url), 'utf8');
  const rules = [...css.matchAll(/(?:^|})\s*([^{}]+)\{/g)];
  assert.ok(rules.length > 0);
  for (const rule of rules) for (const selector of rule[1].split(',')) assert.match(selector.trim(), /^\.stitch-native[-\w]*(?:\s|\.|\[|:|$)/);
  assert.doesNotMatch(css, /@font-face|:root/);
});
