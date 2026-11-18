# Stash Stitch companion server

The optional companion makes Stash groups appear as ordinary videos in a mixed library, including performer profiles. It runs natively on Linux and macOS; Docker is not required. Keep the plugin and server in the same `stash-stitch` repository.

This is **0.3.0-preview.1**, tested against Stash v0.32.0. It is a compatibility preview, not a replacement implementation of every Stash API feature. Android TV/Stashy and physical AirPlay receiver testing are still required.

## What runs where

- Keep your existing Stash server and its library unchanged.
- Run `stitch-server` alongside Stash on Linux, or on a Mac that can reach Stash.
- Point Stashy at the **companion address**, using its **service key** as the API key. This is how it receives the virtual library; connecting directly to the original Stash address will show the original library.
- Open the companion address in a browser to use Stash's existing web interface and native player. Install the matching plugin ZIP in Stash for preparation status, chapter buttons and thumbnail handling. The original Stash address retains browser-only Stitch playback.

The companion reads metadata through Stash GraphQL and downloads originals from Stash's direct `/scene/{id}/stream` endpoint. It never opens your library file paths. FFmpeg reads only those downloaded cache files, with network protocols disabled, and packages encoded packets with **`-c copy`**. It never re-encodes grouped video or audio. Source files are untouched.

## Native installation

1. Download the matching `stitch-server-linux-amd64`, `linux-arm64`, `darwin-arm64` (Apple Silicon), or `darwin-amd64` (Intel Mac) archive from this preview's GitHub release. Extract it.
2. Install **FFmpeg and FFprobe** through your operating system's package manager. FFmpeg 6 or later is recommended. The server does not download or bundle them.
3. Copy `stitch-server.example.json` to `stitch-server.json`. Generate a companion key:

   ```sh
   ./stitch-server -generate-key
   ```

4. Set the following in your private config:

   ```json
   {
     "listen": "0.0.0.0:9998",
     "public_url": "http://YOUR_LINUX_MACHINE:9998",
     "stash_url": "http://127.0.0.1:9999",
     "stash_api_key": "YOUR_EXISTING_STASH_API_KEY",
     "service_key": "THE_RANDOM_COMPANION_KEY",
     "cache_dir": "./stitch-cache"
   }
   ```

   This example runs alongside Stash. When running on a Mac, `stash_url` must point to the Linux Stash address instead. `public_url` must be reachable by your browser **and the TV/AirPlay receiver**; a TV cannot use your Mac's `localhost`. Use explicit `ffmpeg` and `ffprobe` paths if they are not on the service's PATH. No media directories or filesystem mappings are configured.

   Config files contain credentials: keep them private (`chmod 600 stitch-server.json`). `STITCH_STASH_API_KEY` and `STITCH_SERVICE_KEY` can override the two keys via environment variables.

5. Verify and run:

   ```sh
   ./stitch-server -config stitch-server.json -check
   ./stitch-server -config stitch-server.json
   ```

6. In Stashy, add `http://YOUR_LINUX_MACHINE:9998` as a server with the **companion service key**, not Stash's private upstream key. For the browser, open `http://YOUR_LINUX_MACHINE:9998/?apikey=YOUR_COMPANION_KEY` once: it creates an HTTP-only session cookie and redirects to a URL without the key. Use HTTPS via your existing reverse proxy if the connection crosses an untrusted network.

The service key grants the same administrative access as the configured upstream Stash connection. This is a single-user/trusted-household adapter, not a multi-user permission boundary. Ordinary GraphQL mutations are forwarded; mutations targeting virtual scene IDs are blocked except local playback activity. Make administrative changes to original scenes/groups in Stash.

Example background-service definitions are included in `examples/`: a systemd **user** service for Linux, and a LaunchAgent plist for macOS. Replace placeholder paths before enabling either. The plist sets common Homebrew binary paths. Neither is automatically installed.

## Library behaviour

- Eligible groups have at least two direct scenes, usable primary files and positive durations. Scene indices define chapter order; numeric scene ID breaks ties.
- Each group gets a stable ID such as `stitch-12`, one title, group synopsis (or first-scene description), first-scene thumbnail/studio/date, and combined duration.
- Performers and tags are combined across chapters. Matching any chapter in a performer/studio/tag-filtered query includes the group once. The original scene filter is applied by Stash, so multiple conditions must match the same chapter; conditions are not independently matched across different chapters.
- Collapse happens **before pagination**, and scene-result counts/duration/size aggregates describe the collapsed result. Performer/studio/tag `scene_count` badges and global server statistics still come from Stash and can count original scenes.
- A group-filtered `findScenes` request returns original chapters. `findGroup.scenes` and explicit original scene IDs remain original. These are the paths used for inspecting chapters through Groups.
- Overlapping groups use the lowest numeric group ID first; conflicting later groups remain uncollapsed. Subgroups are not recursively stitched.
- Searches retain Stash's chapter search matches and add case-insensitive group-title/synopsis matches, with the client's other filters retained. This additional group-name search is simple substring matching, not Stash's advanced query syntax.
- Title/date/created/updated/rating/play-count/duration sorts are reapplied after grouping. Other sorts retain first-matching-chapter order from Stash. Numeric/range filters (including duration) evaluate original chapter values, not virtual aggregate values.
- Virtual resume time and play count live in the companion cache directory's `activity.json`; original scene histories are not modified by grouped playback. Deleting cache **media/** is safe while stopped; retain `activity.json` to preserve virtual history.

## Playback and cache

Each group produces one full **VOD HLS** playlist with fMP4 segments, an initialization segment per chapter, and discontinuity tags between chapters. Full duration and seeking are available after preparation. The web plugin uses Stash's native player rather than its browser stitching controller on the companion origin.

**The first playback prepares the complete group before serving its playlist.** This can take considerable time for large files, because originals are downloaded through Stash and repackaged. The plugin shows preparation progress. Native clients may time out on that first attempt; prepare the group first, then retry in the app. Subsequent playback reuses cached segments without downloading originals again.

To prepare a known Stash group ID in advance:

```sh
curl -X POST -H 'ApiKey: YOUR_COMPANION_KEY' http://YOUR_LINUX_MACHINE:9998/stitch/groups/12
curl -H 'ApiKey: YOUR_COMPANION_KEY' http://YOUR_LINUX_MACHINE:9998/stitch/groups/12
```

The POST starts an asynchronous job; GET returns status, chapter boundaries and a signed playback URL. The URL is a playback capability for that group, so keep it private. Its manifest and segments are accessible to a receiver without the browser's login cookie. Default token lifetime is 24 hours, configurable up to seven days. Changing `service_key` invalidates old media links.

Defaults: 50 GiB cache budget, 20 GiB per original download, one preparation job at a time, eight queued jobs, 60-minute preparation timeout, 20,000 matching scenes per query. Limits are configurable. Cache eviction removes older unpinned groups, retaining a 30-minute grace period for recently requested media. Preparation fails if room cannot be made; it does not silently delete playback history. Peak packaging uses disk for a downloaded chapter plus the packaged outputs; allow headroom. A group that cannot fit the configured budget is rejected.

## No-transcoding compatibility

The preview accepts H.264 or HEVC video with AAC audio (or no audio), one video track and at most one audio track. Chapters must share the video/audio codec and audio sample rate/channel count. Resolution/frame-rate changes are marked as discontinuities; exact seamless transitions still depend on the receiver. Other codecs, multiple tracks and incompatible layouts produce an explicit error, never an automatic transcode. The TV/browser must support the encoded format. HEVC in Chrome is device-dependent.

Subtitles, markers/funscripts and hover-preview media from the first scene are not advertised as applying to the entire group. Original chapters retain those features. Virtual editing/deletion is rejected. Some specialized clients/features may assume numeric scene IDs or real disk files; these require compatibility testing. No claim is made that unmodified Stashy or physical AirPlay devices have passed device tests yet.

## Build and verify

Go 1.24 or later:

```sh
cd server
go test -race ./...
go vet ./...
go build -trimpath -o stitch-server ./cmd/stitch-server
```

Enable the real stream-copy integration test with `STITCH_TEST_FFMPEG=/path/to/ffmpeg` and `STITCH_TEST_FFPROBE=/path/to/ffprobe`. It generates synthetic media, verifies Stash-only downloads, reads all signed HLS resources with FFprobe, and compares encoded video packet hashes to prove stream copy. No user library or credentials are involved.

From the repository root, `node scripts/package-server.mjs` cross-compiles the four native targets into `.local/server-dist/` and creates archives/checksums. Set `GO` to a compiler path if needed. FFmpeg is an external runtime dependency, not bundled.
