import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { decorateScenePage } from '../src/native-details.js';
const h = React.createElement;
const first = { id: '1', title: 'Original chapter title', details: 'First chapter description', studio: { id: 'studio', name: 'Native studio' }, performers: [{ id: 'p' }], date: '2021-02-05', created_at: '2025-03-14', code: 'original-code' };
function walk(tree, predicate) {
  if (!React.isValidElement(tree)) return undefined;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props.children)) { const found = walk(child, predicate); if (found) return found; }
}
function fixture() {
  return h(React.Fragment, {}, h('title', {}, first.title), h('div', { className: 'scene-header-container' }, h('studio-logo', { studio: first.studio }), h('h3', { className: 'scene-header' }, h('native-text', { text: first.title }))), h('div', { className: 'scene-subheader' }, first.date), h('native-nav-link', { eventKey: 'scene-edit-panel' }, 'Edit'), h('native-pane', { eventKey: 'scene-details-panel' }, h('native-details', { scene: first })), h('native-pane', { eventKey: 'scene-edit-panel' }, h('native-editor', { scene: first })));
}
test('native scene layout inherits studio, dates and performers without mutating the editor', () => {
  const group = { id: '7', name: 'Group title', synopsis: 'Group description' };
  const tree = decorateScenePage(React, fixture(), group, first, h('a', { href: '/groups/7' }, 'Edit group'), '3 chapters · 30:00');
  assert.equal(walk(tree, n => n.type === 'studio-logo').props.studio, first.studio);
  assert.equal(walk(tree, n => n.type === 'native-text').props.text, group.name);
  const details = walk(tree, n => n.type === 'native-details').props.scene;
  assert.equal(details.details, group.synopsis);
  assert.equal(details.performers, first.performers); assert.equal(details.date, first.date); assert.equal(details.code, first.code);
  assert.equal(walk(tree, n => n.type === 'native-editor').props.scene, first);
  assert.equal(React.Children.toArray(walk(tree, n => n.type === 'native-nav-link').props.children).join(''), 'Edit');
  assert.equal(first.title, 'Original chapter title'); assert.equal(first.details, 'First chapter description');
});
test('empty group descriptions inherit the first scene description', () => {
  const tree = decorateScenePage(React, fixture(), { id: '7', name: 'Group' }, first, h('a'), '3 chapters');
  assert.equal(walk(tree, n => n.type === 'native-details').props.scene.details, first.details);
});
