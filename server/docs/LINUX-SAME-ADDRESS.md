# Linux deployment: keep the existing Stash address

This is the deployment handoff for Codex running **on the Linux machine that already serves Stash**. The user has authorized this arrangement: the companion supplies virtual scenes, and the normal public Stash address remains **http://192.168.0.28:9999**. Do the installation and verify it; do not stop at a plan if the machine provides the necessary access.

Use release **v0.3.0-preview.2 or later**. Preview 2 also redirects existing browser-stitching bookmarks to virtual scenes on the same origin.

## Required final arrangement

```text
Browser / Stashy / existing links
        |
        v
http://192.168.0.28:9999   Stash Stitch companion (public entry point)
        |
        v
http://127.0.0.1:9997     the EXISTING Stash process (private upstream)
        |
        v
existing Stash database, settings, library and generated files
```

9997 is an example internal port: verify it is free and select another loopback-only port if necessary. **9999 remains the public address.** Do not install a second Stash instance, create a new Stash database, move its directories, or edit its SQLite database. Keep the existing process's data paths, working directory, service user, environment and other application settings intact. Do not change Harbor or other applications on this machine.

The companion reads originals exclusively through Stash HTTP and packages them with stream copy. No transcoding, quality variants or permanent merged source files are authorized. Downloaded originals and packaged output are allowed in the companion's private cache.

## 1. Inspect and record the current setup

- Read applicable repository/machine instructions and inspect Git status before modifying code.
- Identify the current Stash executable, version, process owner, command line, actual config path and supervisor (systemd, user service, shell launcher, etc.). Do not assume `~/.stash/config.yml` or a service name.
- Identify existing Stitch installations, companion processes/services/configurations, occupied ports, FFmpeg/FFprobe paths and available cache disk space. Reuse a suitable existing companion installation instead of starting duplicate services.
- Record how to restore the current working setup. Back up every Stash config, launch/service definition, companion config and plugin file that will be changed. Use timestamped backups with private permissions. Do not copy the full media library or modify/delete media.
- Inspect credentials locally without printing passwords, API keys, private stream URLs or complete credential-bearing configuration files into chat/logs. Nothing from the user's library or configuration belongs in a public Git commit, issue, release or screenshot.

## 2. Prepare the companion before switching ports

Read `server/README.md` in https://github.com/mjvanraaphorst/stash-stitch for supported codecs, preparation/cache behaviour and API limitations.

- Download the matching `linux-amd64` or `linux-arm64` archive from https://github.com/mjvanraaphorst/stash-stitch/releases/tag/v0.3.0-preview.2 and verify it against that release's `SHA256SUMS`. Install it in an appropriate persistent executable location. Alternatively build the tagged source with Go if that is more appropriate for this machine.
- Ensure FFmpeg and FFprobe are installed through the machine's normal package manager. Configure explicit paths if a background service has a restricted PATH. Do not download random binaries or add encoders to the workflow.
- Install the matching `stash-stitch.zip` plugin into the **existing Stash plugin directory**, preserving other plugins. Reload plugins and verify a single enabled Stash Stitch plugin is loaded. The stable plugin source can remain configured; preview releases are installed manually.
- Create or update a private companion JSON config. Final relevant values are:

  ```json
  {
    "listen": "0.0.0.0:9999",
    "public_url": "http://192.168.0.28:9999",
    "stash_url": "http://127.0.0.1:9997",
    "stash_api_key": "READ_EXISTING_KEY_LOCALLY",
    "service_key": "GENERATE_OR_REUSE_PRIVATE_COMPANION_KEY",
    "cache_dir": "/PERSISTENT/PRIVATE/COMPANION/CACHE",
    "ffmpeg": "/ACTUAL/PATH/ffmpeg",
    "ffprobe": "/ACTUAL/PATH/ffprobe"
  }
  ```

  Replace placeholders locally, not in chat. The service key must be at least 24 random characters; `stitch-server -generate-key` can generate one. Preserve any existing companion key and playback-state/cache directory when upgrading. Set owner-only config permissions. Retain suitable existing cache limits; the defaults are 50 GiB total and 20 GiB per original download, which must fit this machine.

- Configure background supervision consistent with the existing machine. `server/examples/stash-stitch.service` is a **systemd user** example, not a ready-made system service. For a system service, use the actual absolute paths and an appropriate `User=`; ensure it can read its private config and write its cache. Do not enable boot/login policy changes such as systemd lingering unnecessarily.
- If useful, first smoke-test the companion on a temporary unused loopback port against Stash's current address. Stop that temporary process before the final switch. The final `public_url`, listen address and upstream port must be the values above, not the smoke-test values.

## 3. Switch the entry point with rollback ready

- Change only the existing Stash process's effective listen host/port to `127.0.0.1` and the chosen private port. Check command-line flags and service environment as well as config, because they may override YAML. Preserve existing data paths and working directory.
- Restart the existing Stash through its actual supervisor. Verify its API is available locally on the new private port and that the same existing library is present.
- Run `stitch-server -config /ACTUAL/CONFIG.json -check` with the final configuration. It should validate the config and reach the existing Stash API without preparing media.
- Start the supervised companion on the now-free public port 9999. Verify it stays running and only the companion owns the public entry point; Stash itself must be loopback-only.
- Preserve any existing `external_host` or proxy settings that correctly name the public `http://192.168.0.28:9999` origin. Correct them only where necessary, and verify generated asset/stream URLs rather than guessing.

A brief interruption while transferring port 9999 is expected. If the private Stash restart or companion startup fails, restore the saved Stash host/port/launch configuration, stop the companion and restart Stash on its original public address. Confirm the original interface is reachable before continuing troubleshooting. Never leave both processes repeatedly fighting for the same port.

## 4. Authentication and verification

The companion has its **own service-key authentication**; it does not automatically accept an old Stash session cookie or the original username/password login. Be explicit about this when reporting completion. Do not weaken authentication to avoid configuring it.

For a browser, the existing mechanism is a one-time visit to the same public origin with `?apikey=<companion service key>`, which sets an HTTP-only session cookie and redirects to a URL without the key. Keep that capability URL private. Establish it locally or let the user enter the key; do not paste it into the chat. Stashy should keep the usual public server URL and use the companion service key as its API key. Do not assume that changing ports preserves the old client credentials.

Verify all of the following:

1. `http://192.168.0.28:9999/healthz` identifies the companion version. An authenticated `/stitch/info` reports `library: virtual-scenes`, `media_access: stash-only`, and `transcoding: false`.
2. The public address renders the existing Stash interface, and `/stitch/bootstrap.js` is loaded. Plugin settings show one enabled matching preview plugin. Ordinary library objects and assets remain available.
3. Scene results contain both ordinary IDs and virtual `stitch-<groupID>` IDs. A performer who appears in a later chapter sees the grouped video mixed with their ordinary scenes, with no duplicate chapter cards in that normal list.
4. Groups still expose their original individual chapters. First-chapter thumbnail/studio and combined duration/performer metadata look correct.
5. Pick a small compatible group. Prepare it via authenticated `POST /stitch/groups/<groupID>` and poll its GET status. First preparation downloads/repackages the whole group, so allow time. Do not transcode an incompatible group to force the test to pass.
6. The group's full HLS playlist, signed initialization/segment URLs and combined seeking work. Test ordinary standalone playback too. Never publish these private playback URLs.
7. Existing links like `/scenes/<originalID>?stitch=<groupID>` redirect on the **same public origin** to `/scenes/stitch-<groupID>`, preserving a `t` timestamp if present. Original links using `stitch=off` remain original. Old `/plugins/stash-stitch/group/<groupID>` bookmarks also redirect. This prevents an old bookmark from keeping the previous browser playback path.
8. Refresh existing browser tabs. The grouped scene uses the native HLS player and chapter controls. It should not show the old `Compatibility playback · preparing the next chapter` status on a virtual scene.
9. Confirm the normal public address works from another LAN client. Test Stashy/Android TV and Safari/AirPlay if available; otherwise report those device checks as pending. Do not claim physical device compatibility from API checks alone.

## Completion report

Report the public URL, private upstream port, installed versions, service names/status, non-secret config/backup locations, checks performed and any pending device tests. Explain any one-time client authentication action. Include exact rollback commands for the actual supervisor/configuration. Do not include secrets, private media metadata or credential-bearing links. Do not publish deployment files from the machine to GitHub.
