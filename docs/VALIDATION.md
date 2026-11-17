# Preview validation

Validated on 17 November 2026 on macOS with **Stash v0.32.0 (9e9ad972)**. Direct browser checks used Chrome 157.0.8103.79 and Safari 27.0.1; automated checks used Playwright Chromium 159 and WebKit 27.2.

## Automated checks

- Six unit tests: cumulative chapter offsets, exact chapter boundaries, clamped seeks, missing/repeated indices, invalid durations, time formatting, same-origin URL enforcement and byte-range validation.
- Eight browser tests across Chromium and WebKit (four scenarios in each):
  - Group browsing and ungrouped scene browsing.
  - A real 24-second MediaSource timeline assembled from three eight-second H.264/AAC clips, with all chapter openings present in the actual media buffer, playback across a join, forward/backward seeking and natural playback completion.
  - A mixed-resolution group rejected by continuous mode, with working compatibility-mode seeks across scenes.
  - A 120-second clip with distant seeking, eviction of earlier fragments and successful refetch after a backwards seek.
- Fixtures include an MP4 whose metadata is at the end of the file.
- Build and dependency audit completed with no reported dependency vulnerabilities at validation time.

## Stash integration

The official Stash v0.32.0 binary ran in an isolated localhost instance with a temporary database and generated test media. Checks covered manifest discovery, plugin JS/CSS loading, navigation, native GraphQL group queries, chapter order, Stash-served byte-range media and the combined player.

Direct Chrome checks confirmed the three-chapter continuous player prepared chapter openings and could seek into the second chapter. A direct Safari-on-macOS check prepared all three chapter openings, sought to chapter two, played through chapter three and reached the 24-second end. These checks use the packaged plugin, not only the test harness.

## Not established by these checks

Synthetic clips do not prove perceptually gapless sound or frame-perfect joins for arbitrary real-world media. Personal-library testing, large groups, high bitrate/4K material, varying encoder settings, mobile Safari, transcoding streams, remote proxies, authenticated/reverse-proxy deployments and long-duration playback still need broader validation. Play-history, subtitles, funscripts, VR, AirPlay and casting are outside this preview's feature set.

No personal library data, credentials or media are included in the repository or fixtures.
