# Architecture

Stitch registers one Stash UI route prefix and patches navigation, group cards and the group page. All GraphQL operations in the runtime are reads. Metadata comes from the native Group and Scene models; the plugin does not create fake scene records.

## Timeline

Direct group scenes are sorted by `SceneGroup.scene_index`, followed by numeric scene ID when an index is missing or repeated. A chapter's global start is the sum of earlier chapter durations. Global seeking maps into the chapter and its local offset. Native Stash scene durations provide the compatibility timeline; continuous mode uses parsed MP4 movie durations.

## Continuous media path

`Mp4Asset` obtains MP4 metadata with bounded HTTP range requests, including a jump over `mdat` to an end-of-file `moov` when required. MP4Box.js exposes sample offsets and timestamps. Stitch divides video on keyframe boundaries and assigns audio samples to corresponding intervals. It fetches those bytes, creates fragmented MP4 segments in memory, and releases sample payloads after appending.

One media element has a MediaSource with a video SourceBuffer and optional audio SourceBuffer. Track edit-list trim is applied through timestamp offsets. Each chapter's fragments are placed at its global offset. A small start-window tolerance prevents microsecond rounding from discarding an initial keyframe. An initialization segment precedes each fragment so out-of-order chapter preloads and random seeking retain the right decoder configuration. A conservative media signature rejects differing track configurations before playback starts.

The scheduler prioritizes the current seek/playback location, then imminent chapter transitions, then the first five seconds of other chapters. It yields after each fragment, so new seeks can change priority. Fragments are rounded to keyframe boundaries, not exactly five seconds. A memory budget limits speculative preloading. Old fragments outside the playback window are removed; later seeks refetch them. The final segment signals end-of-stream, and later appends can reopen the media source.

## Compatibility path

Two native video elements alternate. The inactive element prepares the next scene while the active element plays. The same combined timeline controls both. This reduces network startup delay but does not promise frame-accurate or gapless element switching. Loading hints are controlled by the browser.

## Lifetime and failures

AbortController cancels reads and pending media operations on navigation or mode changes. Media listeners and timers are removed and object URLs revoked. An unsupported stream or decode failure is displayed with a retry and explicit compatibility option. No automatic switch discards the current position. Resume data is local to the browser and group ID.

The Stash UI plugin API is experimental. Version-specific integration checks are required when Stash changes its patchable components or route rendering.
