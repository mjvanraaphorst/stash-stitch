export function basePath() {
  const base = document.querySelector('base[href]');
  if (base) return new URL(base.href).pathname.replace(/\/$/, '');
  return window.location.pathname.split(/\/(?:plugins|plugin|scenes|groups|performers|studios|tags|galleries|settings|stats)(?:\/|$)/)[0].replace(/\/$/, '');
}

export async function graphql(query, variables = {}, signal) {
  const response = await fetch(`${basePath()}/graphql`, {
    method: 'POST', credentials: 'same-origin', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Stash request failed (${response.status}). Check that you are signed in.`);
  const result = await response.json();
  if (result.errors?.length) throw new Error(result.errors.map(e => e.message).join('; '));
  return result.data;
}

const sceneFields = `id title files { basename duration } paths { screenshot stream } groups { group { id } scene_index } sceneStreams { url mime_type label }`;
export async function getGroup(id, signal) {
  const data = await graphql(`query StitchGroup($id: ID!) { findGroup(id: $id) { id name synopsis front_image_path scenes { ${sceneFields} } } }`, { id }, signal);
  if (!data.findGroup) throw new Error('This group no longer exists.');
  return data.findGroup;
}

export async function browse(kind, search, page, signal) {
  const filter = { q: search, page, per_page: 24, sort: 'created_at', direction: 'DESC' };
  if (kind === 'groups') {
    const data = await graphql(`query StitchGroups($filter: FindFilterType!) { findGroups(filter: $filter, group_filter: { scene_count: { value: 0, modifier: GREATER_THAN } }) { count groups { id name synopsis front_image_path scene_count } } }`, { filter }, signal);
    return data.findGroups;
  }
  const data = await graphql(`query StitchSingles($filter: FindFilterType!) { findScenes(filter: $filter, scene_filter: { is_missing: "group" }) { count scenes { id title details files { duration basename } paths { screenshot } } } }`, { filter }, signal);
  return data.findScenes;
}
