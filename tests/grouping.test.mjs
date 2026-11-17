import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupCatalog, groupedFilter, groupScene, anyIds } from '../src/grouping.js';
const scene = (id, index) => ({ id, groups: [{ group: { id: '7' }, scene_index: index }], files: [{ duration: 10 }] });
const groups = [{ id: '7', name: 'The whole film', synopsis: 'One description', front_image_path: '/cover', scenes: [scene('3', 3), scene('1', 1), scene('2', 2)] }];
test('global representatives prevent repeated groups across separate pages', () => {
  const catalog = groupCatalog(groups);
  assert.equal(catalog.byGroup.get('7').representative, '1');
  assert.deepEqual([...catalog.hidden].sort(), ['2', '3']);
  assert.equal(groupedFilter({ organized: true }, catalog).AND.AND.organized, true);
  const card = groupScene({ id: '1', paths: { screenshot: '/old' }, files: [{ duration: 10 }], title: 'Part one' }, catalog.byGroup.get('7'));
  assert.equal(card.title, 'The whole film'); assert.equal(card.details, 'One description');
  assert.equal(card.files[0].duration, 30); assert.equal(card.__stitchGroup, '7');
});
function match(filter, id) {
  if (!filter) return true;
  const own = (!filter.id || (filter.id.modifier === 'NOT_EQUALS' ? filter.id.value !== id : filter.id.value === id));
  return Boolean(own || (filter.OR && match(filter.OR, id))) && (!filter.NOT || !match(filter.NOT, id)) && (!filter.AND || match(filter.AND, id));
}
test('ID filters keep every member, including large groups', () => {
  const ids = Array.from({ length: 1000 }, (_, i) => String(i + 1));
  const tree = anyIds(ids);
  for (let i = 1; i <= 1000; i++) assert.equal(match(tree, i), true);
  assert.equal(match(tree, 1001), false);
  assert.doesNotThrow(() => JSON.stringify(tree));
});
