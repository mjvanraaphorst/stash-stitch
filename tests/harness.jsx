import React from 'react';
import { createRoot } from 'react-dom/client';
import { ContinuousPlayer, CompatibilityPlayer } from '../src/player.js';
import videojs from 'video.js';

window.PluginApi = {
  React,
  libraries: { ReactRouterDOM: { Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>, useLocation: () => ({ pathname: location.pathname, search: location.search }) } },
  register: { route() {} }, patch: { before() {}, after() {} },
};
window.stitchTest = { ContinuousPlayer, CompatibilityPlayer };
window.stitchTest.getPlayer = () => Object.values(videojs.getPlayers()).find(Boolean);
const { NativePlayer } = await import('../src/native.jsx');
function NativeHarness({ id }) {
  const [group, setGroup] = React.useState();
  React.useEffect(() => { fetch('/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'query StitchGroup($id: ID!) { findGroup(id:$id){id} }', variables: { id } }) }).then(r => r.json()).then(r => setGroup(r.data.findGroup)); }, [id]);
  return group ? <NativePlayer group={group} /> : <p>Loading group…</p>;
}
const match = /\/group\/(\d+)/.exec(location.pathname);
createRoot(document.getElementById('root')).render(<NativeHarness id={match?.[1] || '1'} />);
