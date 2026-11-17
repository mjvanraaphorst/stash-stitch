import React from 'react';
import { createRoot } from 'react-dom/client';
import { ContinuousPlayer, CompatibilityPlayer } from '../src/player.js';

window.PluginApi = {
  React,
  libraries: { ReactRouterDOM: { Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a> } },
  register: { route() {} }, patch: { before() {}, after() {} },
};
window.stitchTest = { ContinuousPlayer, CompatibilityPlayer };
const { Library, GroupPage } = await import('../src/ui.jsx');
const match = /\/group\/(\d+)/.exec(location.pathname);
createRoot(document.getElementById('root')).render(match ? <GroupPage match={{ params: { id: match[1] } }} /> : <Library />);
