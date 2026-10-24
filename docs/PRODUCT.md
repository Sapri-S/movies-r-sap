# Product plan

**Status: implementation authorized. Windows desktop app required, with an optional browser companion.**

## Purpose

Create a private, personal movie app for files the owner supplies. It should feel like a polished streaming service while letting the owner control the collection and its storage.

## Experience

- Dark, cinematic styling inspired by Netflix, with original Movies R Sap branding.
- Artwork cards, clear titles, featured media, and browsing rows.
- An obvious Add videos action and a useful first-run empty state.
- A focused player with standard playback controls and resume support.
- Responsive browsing on desktop and smaller screens.
- Accessible navigation, labeled controls, keyboard operation, and visible focus.

Artwork previews must be clearly identified. The app must never imply that sample artwork includes a playable movie.

## First release

1. Open the Windows desktop executable on the owner's PC. It starts its own backend and displays the library in an app window. A browser companion remains available for optional use.
2. Upload one or more video files into an app-managed media folder, with progress and useful failure messages.
3. Store title, media category, optional year, optional artwork, file details, and date added.
4. Browse, search, filter, and sort the collection.
5. Play browser-compatible videos, seek, and remember playback position across restarts.
6. Add or remove titles from My List.
7. Edit title details and deliberately remove a title from the collection.
8. Preserve the library and video files when the app or browser closes.
9. On explicit request, convert an uploaded MKV or other video to a separate compatible MP4, with progress, cancellation, and original-file preservation.

Use a simple Movies / TV / Home videos category if useful; full season and episode management is a later feature.

## Acceptance criteria

- An uploaded test video remains available after both the app and browser restart.
- Upload failure cannot create a finished-looking but unplayable library record.
- Seeking works without downloading the entire movie first.
- Playback resumes near the last saved point; completed titles can start again.
- Unsupported playback displays a clear explanation instead of an endless loading state.
- Search, filters, metadata edits, and My List reflect persisted library data.
- Removing a library item cannot silently delete the owner's original source file.
- The interface shows where the library is stored and whether the local backend is available.
- The packaged desktop app runs without an installed Node.js runtime or a separate browser.
- Closing the desktop app stops its backend; reopening preserves the library.
- Desktop updates leave the library in the user's application-data folder.

## Later releases

- Register existing folders without copying the whole collection.
- Catalog DVDs, Blu-rays, and 4K discs; attach an imported video to the same title later.
- Move the app and media storage to a dedicated home server.
- Add network storage, multiple profiles, automatic metadata, subtitles, and broader playback support when needed.

Adding a disc to the catalog records ownership. Playing it requires a supported digital video file; disc conversion is a separate future workflow.

## DVD import requirement

The owner wants to add movies from physical DVDs. Support two paths:

- **Initial video library:** accept an already converted, browser-compatible video file through the regular upload flow.
- **Proposed later Import DVD workflow:** use a DVD drive connected to this PC, scan supported disc titles, let the owner choose the movie and available audio/subtitle options, convert to a tested playback profile, and add the verified result to the library.

Show conversion progress, allow cancellation, and report unreadable discs or failed jobs. Do not mark a title playable until its output is verified. Keep the disc unchanged and optionally link the result to its physical-copy record.

Support depends on the disc and selected conversion engine; universal commercial-DVD compatibility is not promised. HandBrake supports readable DVD sources and video conversion, but does not remove copy protection or process DRM-protected content. Engine selection and exact first-release timing remain planning decisions.

Technical references: [HandBrake sources](https://handbrake.fr/docs/en/1.11.0/workflow/open-video-source.html) and [capabilities and limits](https://handbrake.fr/docs/en/1.11.0/introduction/about.html).

## Outside the first release

Public hosting of the movie collection, internet access, public sharing, automatic disc conversion, automatic or on-demand streaming transcoding, native TV apps, and paid-service integrations. Manual creation of a separate MP4 copy is implemented.

## Confirmed scope

- Version one runs only on this Windows PC.
- A Windows desktop app is required alongside the optional browser interface.
- Home-server deployment and access from other devices come later.
- Adding movies from the owner's DVDs is a requested capability; integrated import timing is still proposed.
- The owner authorized local MKV-to-MP4 conversion. Conversion creates a separate title and keeps the original video; it does not scan or decrypt physical discs.

## Initial implementation choices

- One owner, one library, and one PC initially.
- Videos are saved on the PC's disk rather than exclusively in the browser.
- Uploads copy videos into app-managed storage; existing-folder imports come later.
