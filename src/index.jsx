import { register } from './ui.jsx';
if (window.PluginApi) register();
else console.error('Stash Stitch requires the Stash UI plugin API.');
