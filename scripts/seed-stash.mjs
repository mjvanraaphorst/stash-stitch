// Test-only: refuses to touch any instance except the isolated localhost port.
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
const endpoint = 'http://127.0.0.1:4178/graphql';
async function q(query, variables = {}) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const result = await response.json();
  if (result.errors) throw new Error(JSON.stringify(result.errors));
  return result.data;
}
const dataRoot = resolve('.local/stash-data');
for (const sub of ['generated', 'cache', 'blobs', 'metadata']) await mkdir(`${dataRoot}/${sub}`, { recursive: true });
await q('mutation($input: ConfigGeneralInput!) { configureGeneral(input: $input) { ffmpegPath ffprobePath } }', { input: { ffmpegPath: ffmpeg, ffprobePath: ffprobe.path, generatedPath: `${dataRoot}/generated` } });
await q('mutation($input: ScanMetadataInput!) { metadataScan(input: $input) }', { input: { paths: [resolve('.local/media')], scanGenerateCovers: true, scanGeneratePreviews: false, scanGenerateSprites: false, scanGeneratePhashes: false } });
let scenes = [];
for (let attempt = 0; attempt < 60; attempt++) {
  scenes = (await q('{ findScenes(filter: {per_page: -1}) { scenes { id files { basename } } } }')).findScenes.scenes;
  if (scenes.length >= 4) break;
  await new Promise(r => setTimeout(r, 500));
}
if (scenes.length < 4) throw new Error('Synthetic scan did not finish.');
const existing = (await q('{findGroups(filter:{per_page:-1}){groups{id}}}')).findGroups.groups;
if (existing.length) { console.log('Synthetic groups already exist.'); process.exit(0); }
for (const [name, files] of [['A story in three chapters', ['one.mp4', 'two.mp4', 'three.mp4']], ['Mixed formats', ['one.mp4', 'mixed.mp4']]]) {
  const group = (await q('mutation($input: GroupCreateInput!){groupCreate(input:$input){id}}', { input: { name, synopsis: 'One title. One timeline. Generated colours and tones demonstrate chaptered playback.' } })).groupCreate;
  for (const [index, basename] of files.entries()) {
    const scene = scenes.find(s => s.files[0].basename === basename);
    const memberships = (await q('query($id:ID!){findScene(id:$id){groups{group{id} scene_index}}}', { id: scene.id })).findScene.groups.map(g => ({ group_id: g.group.id, scene_index: g.scene_index }));
    await q('mutation($input:SceneUpdateInput!){sceneUpdate(input:$input){id}}', { input: { id: scene.id, title: basename === 'one.mp4' ? 'The opening' : basename === 'two.mp4' ? 'A change of scene' : basename === 'three.mp4' ? 'The final chapter' : 'Different resolution', groups: [...memberships, { group_id: group.id, scene_index: index + 1 }] } });
  }
}
console.log('Seeded isolated Stash with synthetic groups.');
