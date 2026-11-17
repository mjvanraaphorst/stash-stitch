import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('plugin', { recursive: true });
await build({ entryPoints: ['src/index.jsx'], outfile: 'plugin/stash-stitch.js', bundle: true, format: 'iife', target: ['chrome110', 'safari17'], minify: true, legalComments: 'eof', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' });
await copyFile('src/style.css', 'plugin/stash-stitch.css');
console.log('Built plugin/stash-stitch.js and plugin/stash-stitch.css');
