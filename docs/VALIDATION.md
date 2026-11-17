# v0.2.0 validation

Validated on 17 November 2026 against Stash v0.32.0 (9e9ad972) on macOS. Direct native-interface checks used Chrome 157.0.8103.79; automated playback checks use Playwright Chromium and WebKit.

## Regression checks

Eleven unit checks cover edit-list timescales and offsets, contiguous edits, explicit fallback for unsupported media edits, global group representatives, ID exclusion completeness, virtual card metadata, cumulative chapter times, seeking boundaries, invalid durations, same-origin media URLs and bounded byte-range responses.

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
