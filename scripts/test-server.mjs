import { createServer } from 'node:http';
import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
mkdirSync('.local', { recursive: true });
await build({ entryPoints: ['tests/harness.jsx'], outfile: '.local/harness.js', bundle: true, format: 'esm', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' });
const scene = (id, name, order = Number(id)) => ({ id, title: ['The opening', 'A change of scene', 'The final chapter'][Number(id) - 1] || 'Different resolution', details: '', files: [{ basename: `${name}.mp4`, duration: 8 }], paths: { stream: `/media/${name}.mp4`, screenshot: '' }, groups: [{ group: { id: '1' }, scene_index: order }], sceneStreams: [{ url: `/media/${name}.mp4`, mime_type: 'video/mp4', label: 'Direct stream' }] });
const group = id => ({ id, name: id === '2' ? 'Mixed formats' : 'A story in three chapters', synopsis: 'One title. Three scenes. A single timeline. This demonstration uses generated colours and tones.', front_image_path: '', scene_count: 3, scenes: id === '3' ? [{ ...scene('5', 'long'), files: [{ basename: 'long.mp4', duration: 120 }] }] : id === '2' ? [scene('1', 'one'), scene('4', 'mixed')] : [scene('3', 'three'), scene('1', 'one'), scene('2', 'two')] });
const root = resolve('.');
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/graphql') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { query, variables } = JSON.parse(body);
      // Catch unsupported filters even in the mock fixture.
      if (/scene_filter.*group_count/.test(query)) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ errors: [{ message: 'group_count is not a field on SceneFilterType' }] })); return; }
      const data = query.includes('StitchGroup(') ? { findGroup: group(variables.id) } : query.includes('StitchGroups(') ? { findGroups: { count: 2, groups: [group('1'), group('2')] } } : { findScenes: { count: 1, scenes: [scene('4', 'mixed')] } };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data })); return;
    }
    let file;
    if (url.pathname.startsWith('/media/')) file = resolve('.local', url.pathname.slice(1));
    else if (url.pathname === '/harness.js') file = resolve('.local/harness.js');
    else if (url.pathname === '/style.css') file = resolve('src/style.css');
    else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stash Stitch — synthetic demo</title><link rel="stylesheet" href="/style.css"><style>body{margin:0;background:#121819}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>'); return; }
    if (!file.startsWith(`${root}/`)) { res.writeHead(403).end(); return; }
    const size = statSync(file).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416).end(); return; }
    const headers = { 'Content-Type': file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.css') ? 'text/css' : 'text/javascript', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    res.end(readFileSync(file).subarray(start, end + 1));
  } catch (error) { res.writeHead(500).end(error.message); }
}).listen(4177, '127.0.0.1', () => console.log('Synthetic Stash Stitch demo: http://127.0.0.1:4177/plugins/stash-stitch'));
