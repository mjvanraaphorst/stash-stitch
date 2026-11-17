# Native integration

The v0.2 runtime patches Stash's FilteredSceneList, SceneList, SceneCard, SceneCard.Image, ScenePage and ScenePlayer. It does not register a new library/navigation entry. The old plugin route only redirects old links to a native scene URL.

A cached group catalog chooses the first chapter as a representative. Native scene filters are prefixed with ID exclusions for the other members. The exclusions run on the backend before native pagination, so groups do not repeat across pages and the native result count remains usable. The caller's existing filter is retained intact. Search/filter/sort semantics remain those of the representative's original metadata. Bulk selection exits grouped mode; no group display metadata is written onto a scene.

The normal SceneCard renders a virtual copy of the representative with group title, synopsis, cover and total duration. It links to `/scenes/<representative>?stitch=<group>`. Stitched mode replaces only the scene metadata/player panels within the native scene route, using Stash's existing layout classes and Video.js 7.21.7 (the version used by Stash v0.32.0). Original chapter links use `stitch=off` and retain the ordinary scene editor/player.

The timeline sums ordered scene durations. Continuous mode reads MP4 metadata, fetches indexed sample ranges, fragments samples in memory and appends them to video/audio SourceBuffers at global chapter offsets. A leading empty edit is a delay expressed in movie timescale. The edit mapper supports initial empty edits and contiguous unit-rate edits; genuine initial media gaps or discontinuous edits use native compatibility playback instead of manufacturing missing video frames.

Compatibility mode uses one native media element and a speculative next-chapter preload element. Video.js's public timeline/source getters and its HTML5 tech time/seek/buffer methods bridge native controls to the combined timeline. Source changes preserve the group position; original chapter media retains its own edit-list behavior. This path does not promise gapless transitions.

Playback and seek destinations have scheduling priority over chapter-opening preloads. Old fragments are evicted outside the playback window and refetched after backwards seeks. SourceBuffer eviction by the browser invalidates local bookkeeping. Timers, listeners, pending reads and object URLs are cleaned up on navigation/mode changes.

All runtime GraphQL operations are reads. Resume is browser-local; stitched playback does not write global group offsets into an original scene's play history.
