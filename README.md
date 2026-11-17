# Stash Stitch

**Grouped scenes, one item, inside Stash.**

Stash Stitch is a UI plugin for [Stash](https://github.com/stashapp/stash). It collapses scene groups directly in the normal **Scenes** interface. A group gets one native scene card with its title, description, cover and combined duration. Opening it stays on Stash's normal scene page and plays all chapters on one Video.js timeline.

**v0.2.0 preview:** the separate Stitch library from v0.1.0 has been removed. Old Stitch links redirect into the native scene page. No separate helper, permanent file merge, media upload or fake scene records are required.

![Grouped playback inside the native Stash scene page](docs/preview.png)

## Install or update

Tested with **Stash v0.32.0**. Other versions are unverified.

Add this source in **Settings → Plugins → Available Plugins → Add source**:

```text
https://raw.githubusercontent.com/mjvanraaphorst/stash-stitch/main/index.yml
```

Install **Stash Stitch**, or use **Check for updates → Update** if v0.1.0 is already installed. Refresh your browser afterwards.

For manual installation, download `stash-stitch.zip` from [Releases](https://github.com/mjvanraaphorst/stash-stitch/releases), extract its contents into `<Stash plugins>/stash-stitch/`, reload plugins and refresh the browser. The manifest, JS, CSS and license files must sit together in that directory. Node is not needed to use the plugin.

To uninstall, use Stash's plugin manager, or remove the manually installed plugin directory and reload plugins. Media and group metadata remain untouched.

## Using it

1. Add your scenes to a normal Stash group. Set its name, synopsis, cover and scene indices in Stash.
2. Open **Scenes**. **Group scenes: on** collapses each eligible group to one card. The native search, filters, sorting, page size and pagination remain in place.
3. Open the card. Its title and description appear beside the familiar Video.js player. The seek bar covers the entire group, and chapter buttons jump to scene boundaries.
4. Choose **Group scenes: off** to return to individual scenes. Bulk selection automatically switches to individual scenes before native edit/delete actions are used.

Group members remain individually available when editing a group and through the chapter details links. Editing the group's title/description uses Stash's normal group editor; grouped display metadata is never written onto an original scene.

## Playback

Continuous mode fetches MP4 metadata and sample byte ranges, repackages segments in browser memory, and places them on one real media timeline. Playback and seeks take priority, followed by roughly five seconds of each chapter opening (rounded to keyframes and subject to a 64 MB speculative-prebuffer budget).

Leading empty MP4 edits are parsed as timing delays, rather than rejected simply because an edit list has multiple entries. Contiguous unit-rate edits are also recognized. Authored empty intervals, discontinuous edits, unsupported codecs, differing media configurations and other incompatible inputs automatically use **compatibility playback** instead of leaving an unsupported-edit-list error on screen.

Compatibility playback keeps the combined native seek controls while switching original scene streams. It asks the browser to preload the next chapter. Transitions may pause briefly, and an exact five-second native buffer cannot be forced. Stash's existing server streaming options may transcode as they normally do; Stitch adds no server helper.

## Current limits

- The chapter with the first scene index represents each group in the native query. Scene ID breaks missing/repeated index ties. Native filters, search and sorting evaluate that representative scene's original metadata. Group names are displayed on cards, but are not added to Stash's server-side scene text search.
- Backend scene counts and pagination exclude other group members globally, so the same group is not repeated on later pages. The native aggregate duration/file-size byline still describes the representative files, not the expanded chapter collection.
- Groups must have at least two direct scenes with usable durations. Recursive subgroups are not combined. If groups overlap, the first group by numeric ID takes precedence and overlapping later groups are left uncollapsed.
- Group cards and stitched playback are currently intended for native grid browsing. Use individual scenes for tagging, bulk editing, and specialized views.
- Continuous mode requires ordinary, non-fragmented MP4, byte-range support, one video track and at most one audio track. Track IDs, codec strings, resolution and audio configuration must match, and the browser must support those codecs. H.264/AAC is the test baseline.
- Chrome and Safari on macOS are the initial targets. Mobile Safari, AirPlay, casting, VR, subtitles, funscripts and per-scene Stash play-history updates are outside this preview. Use the original scene player for those features.
- Gapless audio/video across arbitrary files is not guaranteed. Browser memory pressure, encoder padding, network conditions and source differences can affect transitions. Resume position is saved locally in the browser by group ID.

All runtime metadata/media reads stay on the current Stash origin with your existing session. There is no telemetry or external runtime CDN. No API key is required by the plugin. Application prebuffer limits are not a hard cap on total browser memory; MP4 metadata and individual fragments also have 64 MB safety limits.

## Development

Use Node 22 or newer:

```sh
npm ci
npm run check
node node_modules/ffmpeg-static/install.js # if npm blocks dependency install scripts
npx playwright install chromium webkit
npm run fixtures
npm run test:browser
npm run package
```

Browser fixtures use generated colours and tones, including a real MP4 with a leading empty edit. `node scripts/test-server.mjs` runs test tooling at `127.0.0.1:4177`; users do not run it to use the plugin. `scripts/seed-stash.mjs` targets an isolated Stash test instance at `127.0.0.1:4178` only.

See [architecture](docs/ARCHITECTURE.md) and [validation notes](docs/VALIDATION.md). Reports should include Stash/browser versions and sanitized errors. Do not post personal media, credentials or authenticated stream URLs to public issues.

## License

MIT. MP4Box.js is BSD-3-Clause; Video.js and its bundled dependencies retain their respective licenses. Full third-party license texts ship with the plugin.
