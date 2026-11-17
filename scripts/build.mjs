import { build } from 'esbuild-wasm';
import { copyFile, mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
await mkdir('plugin', { recursive: true });
const result = await build({ entryPoints: ['src/index.jsx'], outfile: 'plugin/stash-stitch.js', bundle: true, format: 'iife', target: ['chrome110', 'safari17'], minify: true, legalComments: 'eof', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', metafile: true });
// Stash already owns the Video.js skin. Shipping its defaults globally overrides
// Stash's full-width progress bar, even on completely unrelated scenes.
await copyFile('src/native.css', 'plugin/stash-stitch.css');
await copyFile('node_modules/video.js/LICENSE', 'plugin/VIDEOJS-LICENSE.txt');
const packages = new Set(['node_modules/videojs-font']);
for (const input of Object.keys(result.metafile.inputs).filter(p => p.includes('node_modules/'))) {
  let folder = dirname(input);
  while (folder !== '.') {
    try { await access(join(folder, 'package.json')); packages.add(folder); break; } catch { folder = dirname(folder); }
  }
}
const notices = [];
for (const folder of packages) {
  const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
  const files = (await readdir(folder)).filter(name => /^(licen[cs]e|notice|copying)(\.|$)/i.test(name)).sort();
  for (const file of files) notices.push([`${pkg.name}@${pkg.version}/${file}`, await readFile(join(folder, file), 'utf8')]);
}
notices.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
await writeFile('plugin/THIRD-PARTY-LICENSES.txt', notices.map(([name, text]) => `===== ${name} =====\n${text}`).join('\n\n'));
console.log('Built plugin/stash-stitch.js and plugin/stash-stitch.css');
