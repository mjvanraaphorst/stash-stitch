import { getGroup, browse } from './api.js';
import { makeTimeline, locate, clock } from './timeline.js';
import { ContinuousPlayer, CompatibilityPlayer } from './player.js';

const React = window.PluginApi.React;
const { useState, useEffect, useRef } = React;
const { Link } = window.PluginApi.libraries.ReactRouterDOM;
const path = '/plugins/stash-stitch';

function useRequest(load, dependencies) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    load(controller.signal).then(data => { if (!controller.signal.aborted) setState({ data }); }, error => {
      if (!controller.signal.aborted) setState({ error: error.message });
    });
    return () => controller.abort();
  }, dependencies);
  return state;
}

function Header() {
  return <header className="stitch-header"><div><Link to={path} className="stitch-brand">Stash <strong>Stitch</strong></Link><p>Your groups, one timeline.</p></div><span className="stitch-badge">Preview · 0.1</span></header>;
}

export function Library() {
  const [kind, setKind] = useState('groups');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  const { data, error, loading } = useRequest(signal => browse(kind, query, page, signal), [kind, query, page]);
  return <main className="stitch"><Header /><div className="stitch-toolbar"><div role="group" aria-label="Library view">{[['groups', 'Groups'], ['singles', 'Ungrouped scenes']].map(([value, label]) => <button key={value} className={kind === value ? 'selected' : ''} onClick={() => { setKind(value); setPage(1); }}>{label}</button>)}</div><input type="search" aria-label="Search library" placeholder="Search titles…" value={search} onChange={e => setSearch(e.target.value)} /></div>
    <p className="stitch-subtle">{kind === 'groups' ? 'Each group appears once, with its own title, description and chaptered player.' : 'Scenes that do not belong to a group.'}</p>
    {loading && <p role="status">Loading library…</p>}{error && <p role="alert" className="stitch-error">{error}</p>}
    {data && <><p className="stitch-subtle">{data.count.toLocaleString()} {kind === 'groups' ? 'groups' : 'scenes'}</p><div className="stitch-grid">{(data.groups || data.scenes).map(item => <Link className="stitch-card" key={item.id} to={kind === 'groups' ? `${path}/group/${item.id}` : `/scenes/${item.id}`}><div className="stitch-cover">{(item.front_image_path || item.paths?.screenshot) && <img src={item.front_image_path || item.paths.screenshot} alt="" loading="lazy" />}<span>{kind === 'groups' ? `${item.scene_count} chapters` : clock(item.files?.[0]?.duration)}</span></div><div className="stitch-card-copy"><h2>{item.name || item.title || item.files?.[0]?.basename || `Scene ${item.id}`}</h2><p>{item.synopsis || item.details || (kind === 'groups' ? 'Open to play all chapters' : '')}</p></div></Link>)}</div>
      {!data.count && <p>No matching {kind === 'groups' ? 'groups' : 'scenes'}. Add scenes to a group in Stash to get started.</p>}
      <nav className="stitch-pagination" aria-label="Library pages"><button disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {Math.max(1, Math.ceil(data.count / 24))}</span><button disabled={page * 24 >= data.count} onClick={() => setPage(page + 1)}>Next</button></nav></>}
  </main>;
}

function GroupPlayer({ group }) {
  const [mode, setMode] = useState('continuous');
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState('Ready to stitch');
  const [error, setError] = useState('');
  const [timeline, setTimeline] = useState(() => makeTimeline(group.scenes, group.id));
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [buffered, setBuffered] = useState([]);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const videos = [useRef(), useRef()];
  const container = useRef();
  const engine = useRef();
  const resume = useRef(0);
  const seeking = useRef(false);
  const storageKey = `stash-stitch:resume:${group.id}`;
  useEffect(() => { try { resume.current = Math.max(0, Number(localStorage.getItem(storageKey)) || 0); setTime(resume.current); } catch {} }, [storageKey]);
  useEffect(() => {
    if (!started) return;
    let alive = true;
    setError(''); setReady(false); setPlaying(false); setBuffered([]);
    videos[0].current.hidden = false; videos[1].current.hidden = true;
    const notify = update => {
      if (!alive) return;
      if (update.status) setStatus(update.status);
      if (update.buffered) setBuffered(update.buffered);
      if (update.error) { setError(update.error); setPlaying(false); }
    };
    const player = mode === 'continuous' ? new ContinuousPlayer(videos[0].current, group.scenes, group.id, notify) : new CompatibilityPlayer(videos.map(v => v.current), group.scenes, group.id, notify);
    engine.current = player;
    player.open().then(async result => {
      if (!alive) return;
      setTimeline(result);
      await player.seek(Math.min(resume.current, result.duration - 0.05));
      if (alive) setReady(true);
    }).catch(e => {
      if (alive && e.name !== 'AbortError') { setError(e.message); setStatus('Could not prepare playback'); player.destroy(); engine.current = null; }
    });
    let lastSaved = 0;
    const timer = setInterval(() => {
      if (!alive || !player.timeline || !engine.current) return;
      const position = player.currentTime();
      if (!seeking.current) setTime(position);
      if (Date.now() - lastSaved > 3000 && position > 0) {
        resume.current = position >= player.timeline.duration - 1 ? 0 : position;
        try { localStorage.setItem(storageKey, String(resume.current)); } catch {}
        lastSaved = Date.now();
      }
    }, 150);
    return () => { alive = false; clearInterval(timer); player.destroy(); engine.current = null; };
  }, [group.id, mode, revision, started]);
  useEffect(() => { for (const v of videos) if (v.current) { v.current.volume = volume; v.current.playbackRate = rate; } }, [volume, rate, mode, revision]);
  async function toggle() {
    if (!engine.current) return;
    try { if (playing) engine.current.pause(); else await engine.current.play(); } catch (e) { setError(`Playback could not start: ${e.message}`); }
  }
  async function seek(value) {
    setTime(value); resume.current = value;
    try { localStorage.setItem(storageKey, String(value)); } catch {}
    try { await engine.current?.seek(value); } catch (e) { setError(e.message); }
  }
  function switchMode() {
    resume.current = time;
    setMode(mode === 'continuous' ? 'compatibility' : 'continuous');
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (container.current.requestFullscreen) await container.current.requestFullscreen();
      else throw new Error('Combined fullscreen controls are not available in this browser.');
    } catch (e) { setError(e.message); }
  }
  const current = locate(timeline, time);
  return <><div className="stitch-player" ref={container} tabIndex={0} onKeyDown={e => {
    if (e.target !== e.currentTarget || !ready) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); seek(Math.min(timeline.duration, time + 10)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); seek(Math.max(0, time - 10)); }
  }}>
    <div className="stitch-screen">{videos.map((ref, index) => <video key={index} ref={ref} hidden={index === 1} playsInline poster={group.front_image_path || undefined} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />)}
      {!started && <button className="stitch-start" onClick={() => setStarted(true)}>Prepare playback</button>}
      {started && !ready && !error && <span className="stitch-loading" role="status">{status}</span>}
    </div>
    <div className="stitch-controls"><div className="stitch-timeline"><div className="stitch-buffered" aria-hidden="true">{buffered.map(([start, end], i) => <span key={i} style={{ left: `${start / timeline.duration * 100}%`, width: `${(end - start) / timeline.duration * 100}%` }} />)}</div>
      <input aria-label="Combined timeline" type="range" min="0" max={timeline.duration} step="0.1" value={time} disabled={!ready} onPointerDown={() => { seeking.current = true; }} onPointerUp={() => { seeking.current = false; }} onBlur={() => { seeking.current = false; }} onChange={e => seek(Number(e.target.value))} />
      <div className="stitch-marks" aria-hidden="true">{timeline.chapters.slice(1).map(c => <i key={c.scene.id} style={{ left: `${c.start / timeline.duration * 100}%` }} />)}</div>
    </div><div className="stitch-control-row"><button disabled={!ready} onClick={toggle}>{playing ? 'Pause' : 'Play'}</button><span className="stitch-time">{clock(time)} / {clock(timeline.duration)}</span><span className="stitch-chapter-label">Chapter {current.chapterIndex + 1} of {timeline.chapters.length}</span><label className="stitch-volume">Volume <input aria-label="Volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={e => setVolume(Number(e.target.value))} /></label><select aria-label="Playback speed" value={rate} onChange={e => setRate(Number(e.target.value))}>{[0.5, 1, 1.25, 1.5, 2].map(r => <option key={r} value={r}>{r}×</option>)}</select><button onClick={fullscreen}>Fullscreen</button></div></div>
  </div>
    <div className="stitch-playback-status"><span role="status">{status}</span>{started && <button onClick={switchMode}>Use {mode === 'continuous' ? 'compatibility' : 'continuous'} mode</button>}</div>
    {error && <div className="stitch-error" role="alert"><p>{error}</p><button onClick={() => { resume.current = time; setRevision(revision + 1); }}>Retry</button>{mode === 'continuous' && <button onClick={switchMode}>Use compatibility mode</button>}</div>}
    <ol className="stitch-chapters">{timeline.chapters.map((chapter, i) => <li key={chapter.scene.id} className={current.chapterIndex === i ? 'current' : ''}><button disabled={!ready} onClick={() => seek(chapter.start)}><span className="stitch-chapter-number">{String(i + 1).padStart(2, '0')}</span><span><strong>{chapter.scene.title || chapter.scene.files?.[0]?.basename || `Chapter ${i + 1}`}</strong><small>{clock(chapter.start)} · {clock(chapter.duration)}</small></span><span aria-hidden="true">▶</span></button><Link to={`/scenes/${chapter.scene.id}`} title="Open original scene">Details ↗</Link></li>)}</ol>
  </>;
}

export function GroupPage({ match }) {
  const id = match.params.id;
  const { data: group, error, loading } = useRequest(signal => getGroup(id, signal), [id]);
  let validation = '';
  if (group) { try { makeTimeline(group.scenes, group.id); } catch (e) { validation = e.message; } }
  return <main className="stitch"><Header /><Link to={path} className="stitch-back">← All groups</Link>
    {loading && <p role="status">Loading group…</p>}{error && <p role="alert" className="stitch-error">{error}</p>}
    {group && <><div className="stitch-group-title"><div><h1>{group.name}</h1><p>{group.scenes.length} chapters · Original files stay separate</p></div><Link to={`/groups/${id}`}>Edit group in Stash ↗</Link></div>{group.synopsis && <p className="stitch-synopsis">{group.synopsis}</p>}
      {validation ? <p role="alert" className="stitch-error">{validation} Correct the scene metadata in Stash before playing this group.</p> : group.scenes.length ? <GroupPlayer key={id} group={group} /> : <p>This group has no scenes.</p>}
    </>}
  </main>;
}

export function register() {
  const api = window.PluginApi;
  // Stash renders every matching plugin route, rather than using a Switch.
  // Register one prefix route and dispatch its children ourselves.
  function StitchPage() {
    const { pathname } = api.libraries.ReactRouterDOM.useLocation();
    const match = /\/plugins\/stash-stitch\/group\/(\d+)\/?$/.exec(pathname);
    return match ? <GroupPage match={{ params: { id: match[1] } }} /> : <Library />;
  }
  api.register.route(path, StitchPage);
  api.patch.before('MainNavBar.UtilityItems', props => [{ ...props, children: <>{props.children}<Link className="nav-utility stitch-nav" to={path} title="Stash Stitch">Stitch</Link></> }]);
  api.patch.after('GroupPage', (props, result) => <><div className="stitch-entry"><Link to={`${path}/group/${props.group.id}`}>▶ Play with Stitch</Link></div>{result}</>);
  api.patch.before('GridCard', props => [{ ...props, ...((props.className || '').split(' ').includes('group-card') && props.url?.match(/^\/groups\/\d+$/) ? { url: `${path}/group/${props.objectId}` } : {}) }]);
  // Expose library access even on layouts that hide utility navigation items.
  api.patch.after('SettingsToolsSection', (props, result) => <>{result}<p><Link to={path}>Open Stash Stitch</Link></p></>);
}
