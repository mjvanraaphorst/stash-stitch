# v0.2.1 validation

Validated on 17 November 2026 against Stash v0.32.0 (9e9ad972) on macOS. Direct native-interface checks used Chrome 157.0.8103.79; automated playback checks use Playwright Chromium and WebKit.

## Regression checks

Fourteen unit checks cover edit-list timescales and offsets, contiguous edits, explicit fallback for unsupported media edits, global group representatives, ID exclusion completeness, virtual card metadata, cumulative chapter times, seeking boundaries, invalid durations, same-origin media URLs and bounded byte-range responses.

Eight browser checks run four native-player scenarios in Chromium and WebKit:

- The native Video.js timeline covers three clips (24 seconds), prepares chapter starts, crosses a join, seeks in both directions and reaches the final end after seeking.
- A real MP4 generated with leading empty edit-list entries falls back automatically, starts playback and retains combined seeking.
- A long clip evicts old fragments after a distant seek and refetches them on a backwards seek.
- Mixed media configurations use compatibility playback while retaining global time and native seeking.

The edit regression fixture has video and audio edit lists with different movie-time delays and media-time trims. Unit checks do not merely remove the rejection; they verify the timescale mapping and preservation of those offsets.

## Actual Stash integration

An isolated official Stash v0.32.0 instance uses a temporary database and generated media. Backend query checks confirm exclusions reduce four original scenes to two native results: one three-chapter group and one remaining individual scene. Direct Chrome checks confirm native scene cards, group metadata, native scene URLs, native pagination, and the Video.js player within Stash's scene-detail layout. The separate v0.1 library is removed from the runtime.

Synthetic tests do not establish perceptually gapless playback for arbitrary real media. Browser memory management, media compatibility, complex edits, source changes and remote streaming conditions remain practical constraints. See README for filtering/representative behavior and unsupported specialized features.

No private media, credentials or personal library screenshots are included in the public repository.

## Native appearance and CSS regressions

The native-details decorator is checked for inherited studio, date and performer data, group-description fallback, and preservation of the real first-scene editor object. Thumbnail and poster checks use the first chapter. Every shipped CSS selector is required to be scoped to Stitch; global Video.js defaults are excluded. Native scene-page and ordinary-player sizing are also inspected inside the isolated Stash instance.

## Companion preview — 2026-11-18

- 11 Go tests passed with the race detector, including actual synthetic media packaging, authenticated upstream access, signed manifest/segment requests, unchanged encoded video packet hashes, performer union, pre-pagination collapse, aliases/fragments/variables/defaults/directives, local virtual activity, blocked virtual deletion, and secret masking. `go vet ./...` passed.
- Existing 14 JavaScript tests and 8 Chromium/WebKit browser-only playback checks passed.
- A fresh official Stash v0.32.0 instance at a loopback-only test port served generated clips. The companion's packaged native Mac binary exposed one virtual group mixed with standalone scenes. `scripts/test-companion.mjs` confirmed a later-chapter performer's profile returns that group plus a standalone, correct pagination, first-scene studio/thumbnail, original group chapters, and a readable complete HLS playlist.
- Chrome UI verification used the actual Stash web interface through the companion: native scene cards/details, one complete timeline, successful playback at the third chapter, and chapter buttons. Synthetic screenshots only; no user media or credentials are published.
- Four native binaries built successfully: Linux amd64/arm64 and macOS amd64/arm64. Linux execution is covered by the companion CI workflow, not claimed as locally exercised on this Mac.
- Physical AirPlay receiver testing, actual Safari hardware playback and Stashy Android TV application testing remain unverified. API/source-level compatibility is not a claim of completed device testing. The first-play full-group cache preparation and specialized API/filter limits are documented in the server guide.

## Same-address deployment update — v0.3.0-preview.2

The Linux deployment guide covers retaining public port 9999, moving the existing Stash process to a private loopback port, private authentication setup, backups and rollback. New server redirects translate old `/scenes/<id>?stitch=<group>` and `/plugins/stash-stitch/group/<id>` bookmarks into same-origin virtual scene routes, preserving timestamp/filter query parameters. Twelve companion tests passed with the race detector, including real stream-copy packaging and the new redirect coverage; `go vet` passed. This update has not itself changed the user's Linux services; that deployment is delegated to Codex on the Linux machine using the published guide.
