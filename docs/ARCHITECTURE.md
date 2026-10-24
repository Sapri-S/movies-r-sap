# Architecture proposal

**Status: first release implemented, including the requested Windows desktop app and an optional browser companion.**

## Core decision

Use a shared interface plus a small backend running on the owner's PC. The primary Windows desktop app embeds both through Electron; the browser companion can run the same backend separately. Store movie files on disk and metadata in SQLite. A later home-server milestone can reuse the API, interface, and media model.

The browser should display the collection and play video; it should not be the sole durable home for large movie files.

## Boundaries

```text
Browser UI
    |
    | private application API
    v
Library and playback services
    |                       |
    v                       v
Metadata repository       Media-source interface
    |                       |
    v                       v
Local database            Managed disk folder
                          Later: existing folders / network storage
```

- **UI:** browsing, forms, upload progress, and player controls.
- **API:** request validation, access checks, and stable response shapes.
- **Services:** library rules, upload completion, watch progress, and watchlist behavior.
- **Metadata repository:** database operations and migrations.
- **Media source:** resolve an opaque file reference, inspect file information, read a requested range, and report availability.

Start with one working disk source. Add another implementation when a real second source is needed. Avoid a plugin framework or multiple services for the first release.

## Implemented technology

A single repository contains plain JavaScript ES modules, a buildless HTML/CSS frontend, Node HTTP and SQLite APIs, and an Electron 45.0.0 desktop shell. Development targets Node 24.11+. The packaged Electron runtime includes its own Node 24.22.0 and Chromium runtime; no external runtime is needed by the user. @electron/packager 20.3.0 produces the portable Windows x64 application folder.

The early TypeScript direction was simplified to JavaScript modules with separate files and behavior tests. The HTTP/SQLite backend uses Node's native APIs. The pinned `ffmpeg-static` 5.3.0 production dependency supplies a separate local conversion executable. Electron and its packager are pinned development dependencies in package-lock.json.

## Source layout

```text
desktop/main.mjs          Desktop window, lifecycle, menus, and policies
dist/                     Shared browser/desktop interface and assets
apps/server/              API, library services, and startup
apps/server/media/        Disk source and streaming
apps/server/database.mjs  Metadata queries and versioned schema
tests/                    Backend integration and frontend regressions
scripts/                  Source checks and desktop packaging
docs/                     Product, architecture, and roadmap
```

Runtime media and databases remain outside source-controlled code. The desktop uses app.getPath('userData')/library (normally %APPDATA%/Movies R Sap/library). The browser companion defaults to the gitignored data/ folder, with MOVIES_DATA_DIR overriding that location. A process lock prevents simultaneous writers to one library.

## Desktop boundary

Electron starts the backend on an ephemeral loopback port, then loads only that origin in a sandboxed window with Node integration disabled and context isolation enabled. It exposes no preload/IPC bridge. Foreign navigation, new windows, and unnecessary permissions are denied. Metadata export alone can trigger a native save dialog.

The app uses a single-instance lock, focuses an existing window on repeated launch, and closes the renderer before stopping its backend. Playback position is saved periodically; the final close-time save is best-effort. Runtime data stays outside app.asar so replacing the distribution preserves the library. Smoke tests use an explicitly isolated directory.

The shared player preserves source aspect ratio with Fit (`contain`) and offers explicit Fill (`cover`) cropping. Fullscreen can target the video wrapper, retaining its sizing toolbar, or the native video element; both clear ordinary dialog height limits. Keyboard shortcuts work only while the player is open and do not intercept editable fields or modified keys. Sizing changes affect display only and never rewrite source media.

## Portable library records

- `Title`: stable ID, title, category, year, artwork reference, date added.
- `MediaAsset`: stable ID, title ID, source ID, source-relative file key, size, format details, availability.
- `WatchProgress`: title/asset ID, playback seconds, duration, updated time, completion state.
- `WatchlistEntry`: title ID and added time.
- `PhysicalCopy` (later): title ID, disc format, edition, location, notes.

Keep a title separate from its playable asset so a cataloged disc can gain a video later. Use a single-owner model first; add profiles through a migration when needed.

Persist source-relative keys, not a hardcoded drive letter for every title. A source configuration maps those keys to the current machine's storage location.

## Upload and playback lifecycle

1. Stream an upload to a temporary file rather than buffering a whole movie in memory.
2. Validate the request, available space, and expected file handling.
3. Complete the file write before making the library item playable.
4. Handle partial uploads, canceled requests, and interrupted completion; clean up abandoned temporary files.
5. Serve video through media IDs with HTTP range support for seeking.
6. Save playback position periodically and on pause/exit where possible.
7. Return a useful unavailable/unsupported state when an asset cannot play.

Direct playback targets files the selected browser can decode. An explicit Convert to MP4 action can create a compatible copy; automatic streaming transcoding remains a separate later milestone.

## Local MP4 conversion

`apps/server/media/conversion.mjs` manages one local FFmpeg process at a time. The API accepts an existing title ID and the fixed conversion profile, not arbitrary filenames or FFmpeg arguments. It uses argument arrays with no shell, restricts protocols to local files/pipes, hides the process window, and supports cancellation and shutdown.

The profile selects the first video and optional first audio track, encodes H.264/yuv420p plus AAC stereo, and writes a fast-start MP4. Subtitles, additional tracks, and attachments are left in the original. Progress comes from FFmpeg's output; the result must contain encoded frames and decode a frame before journaled publication. Disk space is checked before and during conversion, with a 100 GB output limit.

The output receives a new title and media asset with independent artwork. The original remains unchanged and cannot be deleted during its active conversion. Temporary output is removed on failure, cancellation, or startup recovery. Recent jobs are atomically persisted in `conversion-jobs.json`; running records become interrupted after a crash. Normal shutdown cancels active encoding, and jobs are not automatically resumed.

Source runs use the npm-supplied executable. Packaged Windows runs explicitly use `resources/ffmpeg/ffmpeg.exe`, outside ASAR, with the engine's upstream license and build provenance. See `THIRD_PARTY_NOTICES.md`.

## Planned DVD import boundary

Keep disc scanning and conversion in a local backend module, separate from browser uploads and ordinary playback. Use a replaceable conversion-engine adapter; evaluate a supported engine such as HandBrake during that milestone.

Represent imports as persisted jobs with source, selected title, audio/subtitle choices, output profile, status, progress, and error details. Begin with one conversion at a time. On app restart, mark interrupted jobs explicitly; do not imply that conversion can automatically resume.

Write to temporary output, handle cancellation, low disk space, and disc removal, then verify the result before publishing a MediaAsset. Link it to an existing title/physical copy when appropriate. Record source provenance without making continued playback depend on the DVD drive or inserted disc.

Do not promise support for every disc. For example, [HandBrake's documented limits](https://handbrake.fr/docs/en/1.11.0/introduction/about.html) include copy-protected/DRM sources. Select and test supported inputs and outputs before enabling Import DVD.

## Ownership and access

- Bind to the local machine by default.
- Never let a browser request arbitrary disk paths. Resolve media IDs through configured storage roots and enforce path boundaries.
- Generate storage filenames; retain original filenames only as metadata.
- Treat uploads, filenames, and metadata as untrusted inputs.
- Make removal behavior explicit. Never silently erase an original file outside app-managed storage.
- Add authentication, secure transport, and an explicit access policy before enabling access beyond the local machine.

## Growth and recovery

- Version the database schema and migrate existing libraries.
- Keep metadata backups and video backups separate; both are needed for full recovery.
- Document export/restore and relocation before a server migration.
- Keep API response contracts stable as storage implementations change.
- Add integrations such as metadata providers behind focused modules when requested.

## Decision record

| Decision | State | Reason |
| --- | --- | --- |
| This Windows PC first; home server later | Confirmed by user | Keep initial use on one PC and defer network-device access. |
| Windows desktop app plus browser companion | Implemented | User explicitly requested an actual desktop application as well. |
| Add movies from physical DVDs | Requested by user; implementation proposed | Accept converted files first and plan an integrated local import workflow. |
| Local backend plus disk media storage | Implemented | Establish durable storage and a practical path to a home server. |
| Metadata separate from video bytes | Implemented | Keep browsing and backups manageable as the collection grows. |
| Stable title IDs separate from media assets | Implemented | Support physical copies and future attached videos. |
| Browser IndexedDB media experiment | Archived in prototypes/ | Unused; the app uses durable disk storage instead. |
| Private Sites draft | Unpublished, provisional | Created before planning; not a chosen host for the media backend. |
