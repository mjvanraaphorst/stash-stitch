import { registerNative } from './native.jsx';
if (window.PluginApi) registerNative();
else console.error('Stash Stitch requires the Stash UI plugin API.');
