import videojs from 'video.js';
import { getCatalog, getGroup } from './api.js';
import { groupCatalog, groupedFilter, groupScene } from './grouping.js';
import { makeTimeline, clock } from './timeline.js';
import { ContinuousPlayer } from './player.js';
import { NativeCompatibility } from './native-compatibility.js';
import { decorateScenePage } from './native-details.js';

const React = window.PluginApi.React;
const { useEffect, useState, useRef, useMemo, useContext, createContext } = React;
const { Link, useLocation, Redirect } = window.PluginApi.libraries.ReactRouterDOM;
const ListContext = createContext(null);

function useGroup(id) {
  const [state, set] = useState({ loading: true });
  useEffect(() => {
    const abort = new AbortController();
    set({ loading: true });
    getGroup(id, abort.signal).then(group => { if (!abort.signal.aborted) set({ group }); }, e => { if (!abort.signal.aborted) set({ error: e.message }); });
    return () => abort.abort();
  }, [id]);
  return state;
}

function groupId() {
  const location = useLocation();
  const value = new URLSearchParams(location.search).get('stitch');
  return value && /^\d+$/.test(value) ? value : null;
}

export function NativePlayer({ group, initialTimestamp = 0, autoplay = false }) {
  const mount = useRef(), bridge = useRef(), vjs = useRef();
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState('continuous');
  const [status, setStatus] = useState('Preparing group…');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [timeline, setTimeline] = useState(() => makeTimeline(group.scenes, group.id));
  const position = useRef(initialTimestamp);
  const storageKey = `stash-stitch:resume:${group.id}`;
  useEffect(() => {
    if (initialTimestamp) position.current = initialTimestamp;
    else try { position.current = Number(localStorage.getItem(storageKey)) || 0; } catch {}
  }, [group.id, initialTimestamp]);
  useEffect(() => {
    let alive = true, controller;
    const element = document.createElement('video-js');
    element.classList.add('video-js', 'vjs-default-skin', 'vjs-big-play-centered');
    element.setAttribute('playsinline', '');
    mount.current.appendChild(element);
    const first = makeTimeline(group.scenes, group.id).chapters[0]?.scene;
    const player = videojs(element, { controls: true, preload: 'auto', fluid: true, autoplay: false, playbackRates: [0.5, 1, 1.25, 1.5, 2], controlBar: { children: ['playToggle', 'volumePanel', 'currentTimeDisplay', 'timeDivider', 'durationDisplay', 'progressControl', 'playbackRateMenuButton', 'fullscreenToggle'] }, poster: first?.paths?.screenshot || '' });
    vjs.current = player;
    setReady(false); setError(''); setStatus('Preparing group…');
    const announce = update => { if (alive && update.status) setStatus(update.status); if (alive && update.error) setError(update.error); };
    const start = async () => {
      const video = player.el().querySelector('video');
      // Sources are supplied by our timeline controller, rather than Video.js's
      // source selector. Its public source getter must reflect the active URL,
      // otherwise Video.js queues Play forever waiting for a source to be set.
      player.currentSource = () => ({ src: video.currentSrc || video.src, type: 'video/mp4' });
      controller = mode === 'continuous' ? new ContinuousPlayer(video, group.scenes, group.id, announce) : new NativeCompatibility(video, group.scenes, group.id);
      bridge.current = controller;
      // Adapt the native Video.js controls to the virtual timeline. In continuous
      // mode the media element already has global times; compatibility uses offsets.
      const tech = player.tech({ IWillNotUseThisInPlugins: true });
      const techTime = tech.currentTime.bind(tech);
      const techDuration = tech.duration.bind(tech);
      const techBuffered = tech.buffered.bind(tech);
      const techSeekable = tech.seekable.bind(tech);
      const techSetTime = tech.setCurrentTime.bind(tech);
      tech.currentTime = () => controller?.timeline ? controller.currentTime() : techTime();
      tech.duration = () => controller?.timeline?.duration || techDuration();
      tech.buffered = () => controller?.timeline && mode === 'compatibility' ? videojs.createTimeRanges(controller.buffered()) : techBuffered();
      tech.seekable = () => controller?.timeline ? videojs.createTimeRanges([[0, controller.timeline.duration]]) : techSeekable();
      tech.setCurrentTime = time => {
        if (!controller?.timeline) return techSetTime(time);
        Promise.resolve(controller.seek(time)).catch(e => { if (alive) setError(e.message); });
      };
      try {
        const result = await controller.open();
        if (!alive) return;
        setTimeline(result);
        await controller.seek(Math.min(Math.max(0, position.current), result.duration - 0.05));
        player.duration(result.duration);
        if (mode === 'compatibility') setStatus('Compatibility playback · preparing the next chapter');
        setReady(true);
        if (autoplay) await player.play();
      } catch (e) {
        if (!alive || e.name === 'AbortError') return;
        if (mode === 'continuous') {
          // Unsupported edits/codecs still get a playable native combined timeline.
          setMode('compatibility');
          setStatus('Using compatibility playback');
        } else setError(e.message);
      }
    };
    player.ready(() => start().catch(e => { if (alive) setError(e.message); }));
    const save = setInterval(() => {
      if (!alive || !controller?.timeline) return;
      const time = controller.currentTime();
      if (time > 0) {
        position.current = time >= controller.timeline.duration - 0.5 ? 0 : time;
        try { localStorage.setItem(storageKey, String(position.current)); } catch {}
      }
    }, 1000);
    return () => { alive = false; clearInterval(save); controller?.destroy(); bridge.current = null; player.dispose(); vjs.current = null; };
  }, [group.id, mode, revision]);
  function seek(time) {
    position.current = time;
    try { localStorage.setItem(storageKey, String(time)); } catch {}
    vjs.current?.currentTime(time);
  }
  return <div className="VideoPlayer stitch-native-player"><div ref={mount} />
    <div className="stitch-native-status"><small role="status">{status}</small>{ready && <button className="btn btn-secondary minimal" onClick={() => { position.current = bridge.current?.currentTime() || 0; setMode(mode === 'continuous' ? 'compatibility' : 'continuous'); }}>Use {mode === 'continuous' ? 'compatibility' : 'continuous'} playback</button>}</div>
    {error && <div className="alert alert-danger" role="alert">{error} <button className="btn btn-secondary" onClick={() => setRevision(revision + 1)}>Retry</button></div>}
    <div className="stitch-native-chapters" aria-label="Group chapters">{timeline.chapters.map((c, i) => <button disabled={!ready} className="btn btn-secondary" key={c.scene.id} onClick={() => seek(c.start)} title={c.scene.title || `Chapter ${i + 1}`}>{i + 1} · {clock(c.start)}</button>)}</div>
  </div>;
}

function NativeGroupPlayer(props) {
  const id = groupId();
  const { group, error } = useGroup(id);
  if (error) return <div className="alert alert-danger">{error}</div>;
  return group ? <NativePlayer {...props} group={group} /> : <p role="status">Loading group…</p>;
}

function NativeGroupDetails({ original, originalProps }) {
  const id = groupId();
  const { group, error } = useGroup(id);
  if (!group) return <div className="scene-tabs order-xl-first order-last"><p>{error || 'Loading group…'}</p></div>;
  const timeline = makeTimeline(group.scenes, group.id);
  const first = timeline.chapters[0]?.scene;
  if (!first) return React.createElement(original, originalProps);
  if (originalProps.scene.id !== first.id) return <Redirect to={`/scenes/${first.id}?stitch=${id}`} />;
  return <NativeScenePageView original={original} originalProps={originalProps} group={group} summary={`${group.scenes.length} chapters · ${clock(timeline.duration)}`} />;
}

function NativeScenePageView({ original, originalProps, group, summary }) {
  // Invoke the unpatched native render inside this stable React component so its
  // hooks, layout, studio logo, tabs, performers and native action handlers stay
  // intact. Only the returned display tree is decorated.
  const tree = original(originalProps);
  const link = <Link to={`/groups/${group.id}`}>Edit group</Link>;
  return decorateScenePage(React, tree, group, originalProps.scene, link, summary);
}

function NativeList({ original, originalProps }) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem('stash-stitch:group-scenes') !== 'false');
  const [catalog, setCatalog] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    getCatalog().then(groups => { if (alive) setCatalog(groupCatalog(groups)); }, e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  const hook = useMemo(() => filter => {
    const effective = originalProps.filterHook ? originalProps.filterHook(filter) : filter;
    if (!enabled || !catalog || effective.displayMode !== 0) return effective;
    const copy = effective.clone();
    const make = copy.makeFilter.bind(copy);
    copy.makeFilter = () => groupedFilter(make(), catalog);
    return copy;
  }, [originalProps.filterHook, enabled, catalog]);
  const context = useMemo(() => ({ enabled, catalog, setEnabled }), [enabled, catalog]);
  function toggle() { setEnabled(!enabled); localStorage.setItem('stash-stitch:group-scenes', String(!enabled)); }
  return <ListContext.Provider value={context}><div className="stitch-native-list"><div className="stitch-native-switch"><button className={`btn btn-secondary ${enabled ? 'active' : ''}`} aria-pressed={enabled} onClick={toggle}>Group scenes: {enabled ? 'on' : 'off'}</button><small className="text-muted">{error ? `Grouping unavailable: ${error}` : 'Bulk selection switches to individual scenes.'}</small></div>{catalog || error || !enabled ? React.createElement(original, { ...originalProps, filterHook: hook }) : <p role="status">Loading scene groups…</p>}</div></ListContext.Provider>;
}

function NativeScenes({ original, originalProps }) {
  const state = useContext(ListContext);
  const selecting = originalProps.selectedIds?.size > 0;
  useEffect(() => { if (selecting && state?.enabled) state.setEnabled(false); }, [selecting, state?.enabled]);
  const scenes = state?.enabled && state.catalog && !selecting && originalProps.filter?.displayMode === 0 ? originalProps.scenes.map(s => {
    const group = state.catalog.byScene.get(s.id);
    return group ? groupScene(s, group) : s;
  }) : originalProps.scenes;
  return React.createElement(original, { ...originalProps, scenes });
}

function LegacyPage() {
  const location = useLocation();
  const id = /\/group\/(\d+)/.exec(location.pathname)?.[1];
  return id ? <LegacyGroup id={id} /> : <Redirect to="/scenes" />;
}
function LegacyGroup({ id }) {
  const { group, error } = useGroup(id);
  if (!group) return <p>{error || 'Loading group…'}</p>;
  const first = makeTimeline(group.scenes, id).chapters[0];
  return <Redirect to={first ? `/scenes/${first.scene.id}?stitch=${id}` : `/groups/${id}`} />;
}

export function registerNative() {
  const api = window.PluginApi;
  // React 18 passes a legacy context/ref argument in addition to props. Stash
  // appends the original render function after all of those arguments.
  const instead = (name, fn) => api.patch.instead(name, (...args) => fn(args[0], args.at(-1)));
  api.register.route('/plugins/stash-stitch', LegacyPage);
  instead('FilteredSceneList', (props, original) => props.fromGroupId ? React.createElement(original, props) : <NativeList original={original} originalProps={props} />);
  instead('SceneList', (props, original) => <NativeScenes original={original} originalProps={props} />);
  api.patch.after('SceneCard', (...args) => { const props = args[0], result = args.at(-1); return props.scene.__stitchGroup ? React.cloneElement(result, { url: `/scenes/${props.scene.id}?stitch=${props.scene.__stitchGroup}` }) : result; });
  instead('SceneCard.Image', (props, original) => props.scene.__stitchGroup ? <div className="scene-card-preview"><img className="scene-card-preview-image" loading="lazy" src={props.scene.paths.screenshot} alt="" /><span className="stitch-native-badge">{props.scene.__stitchChapters} chapters</span></div> : React.createElement(original, props));
  instead('ScenePlayer', (props, original) => <PlayerDispatch original={original} originalProps={props} />);
  instead('ScenePage', (props, original) => <DetailsDispatch original={original} originalProps={props} />);
}

// On the companion origin, library grouping and the single timeline come from
// the server. Wait for a cold cache explicitly so a native player does not time
// out while the complete original-quality HLS presentation is being prepared.
export function registerCompanion() {
  window.PluginApi.patch.instead('SceneCard.Image', (...args) => {
    const props = args[0], original = args.at(-1);
    return props.scene?.id?.startsWith('stitch-')
      ? <CompanionCardImage original={original} originalProps={props} />
      : React.createElement(original, props);
  });
  window.PluginApi.patch.instead('ScenePlayer', (...args) => {
    const props = args[0], original = args.at(-1);
    return props.scene?.id?.startsWith('stitch-')
      ? <CompanionPlayer original={original} originalProps={props} />
      : React.createElement(original, props);
  });
}

function CompanionCardImage({ original, originalProps }) {
  const tree = original(originalProps);
  const children = React.Children.map(tree.props.children, child => {
    if (!React.isValidElement(child) || !('image' in child.props) || !('vttPath' in child.props)) return child;
    return <div className={`scene-card-preview${child.props.isPortrait ? ' portrait' : ''}`}><img className="scene-card-preview-image" loading="lazy" src={child.props.image} alt="" /></div>;
  });
  // Keep Stash's own resolution/duration overlays and rating banner; only the
  // hover preview is omitted because it belongs to an individual source scene.
  return React.cloneElement(tree, {}, children);
}

function CompanionPlayer({ original, originalProps }) {
  const id = originalProps.scene.id.slice('stitch-'.length);
  const mount = useRef();
  const [state, setState] = useState(null), [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let timer;
    setState(null); setError('');
    async function poll(method = 'GET') {
      try {
        const response = await fetch(`/stitch/groups/${encodeURIComponent(id)}`, { method, credentials: 'same-origin', signal: abort.signal });
        if (!response.ok) throw new Error(`Group preparation failed (${response.status}).`);
        const next = await response.json();
        if (abort.signal.aborted) return;
        setState(next);
        if (next.error) setError(next.error);
        else if (next.status !== 'ready') timer = setTimeout(() => poll(), 1000);
      } catch (e) { if (!abort.signal.aborted) setError(e.message); }
    }
    poll('POST');
    return () => { abort.abort(); clearTimeout(timer); };
  }, [id, attempt]);
  return <div ref={mount} className="stitch-native-player">
    {error ? <div className="alert alert-danger" role="alert">{error} <button className="btn btn-secondary" onClick={() => setAttempt(attempt + 1)}>Retry</button></div>
      : state?.status === 'ready' ? React.createElement(original, originalProps)
        : <p role="status">Preparing original-quality playback… {state?.status || ''}. First playback prepares a cached copy; no transcoding.</p>}
    {state?.status === 'ready' && <div className="stitch-native-chapters" aria-label="Group chapters">{state.chapters.map((chapter, i) => <button className="btn btn-secondary" key={chapter.scene_id} onClick={() => { const video = mount.current?.querySelector('video'); if (video) video.currentTime = chapter.start; }}>{i + 1} · {clock(chapter.start)}</button>)}</div>}
  </div>;
}
function PlayerDispatch({ original, originalProps }) { return groupId() ? <NativeGroupPlayer {...originalProps} /> : React.createElement(original, originalProps); }
function DetailsDispatch({ original, originalProps }) { return groupId() ? <NativeGroupDetails original={original} originalProps={originalProps} /> : React.createElement(original, originalProps); }
