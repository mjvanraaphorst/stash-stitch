import { registerNative, registerCompanion } from './native.jsx';
// The companion already exposes groups as native Scene objects. Applying the
// browser-only collapsing layer a second time would hide chapters twice.
if (window.__STASH_STITCH_PROXY__ && window.PluginApi) registerCompanion();
else if (window.PluginApi) registerNative();
else console.error('Stash Stitch requires the Stash UI plugin API.');
