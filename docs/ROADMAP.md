# Roadmap

**Current phase: first release built and validated, including the Windows desktop application.**

Each milestone should end with a working, reviewable result. Update status from demonstrated behavior rather than code volume.

## 0. Agree on the plan — complete

- [x] Draft the five project documents.
- [x] Confirm the first device: this Windows PC only; home server later.
- [x] Proceed with managed local disk copies; disk space is checked by the upload backend.
- [x] Confirm the first release through the user's execution request.
- [x] Accept converted DVD video files first; keep integrated importing in a later milestone.
- [x] Approve the architecture and authorize implementation.
- [x] Incorporate the subsequent requirement for a Windows desktop app as well.

## 1. Prove the media path

- [x] Select and record the application stack and supported versions.
- [x] Create a runnable local app and clear startup instructions.
- [x] Establish runtime storage paths and a versioned metadata database.
- [x] Upload a real CC0 MP4 through the UI and list it in the library.
- [x] Verify real browser video decoding/playback and HTTP range seeking.
- [x] Verify file bytes and saved metadata after backend reopen in integration tests.
- [x] Verify interrupted uploads and file path boundaries.

**Done when:** one real video survives restart and plays/seeks through the actual storage path.

## 2. Build the personal cinema experience

- [x] Build the cinematic home page and responsive library views.
- [x] Add search, filters, sorting, and metadata editing.
- [x] Add artwork selection and useful empty/error states.
- [x] Add My List, watch progress, and Continue watching.
- [x] Add multi-file upload progress and explicit removal behavior.
- [x] Verify browser upload/playback, detail editing, My List, and search flows.
- [x] Document backup locations and basic recovery.
- [x] Package a self-contained Windows desktop executable and launcher.
- [x] Pass source and packaged desktop startup checks, including SQLite, bundled static files, backend connection, and renderer isolation.
- [x] Pass 20 integration/regression tests and source syntax checks.
- [ ] Verify the owner's actual DVD-derived movie files and preferred audio/subtitle combinations.

**Done when:** the owner can add, find, watch, resume, and organize their own videos reliably.

## 3. Expand the collection

- [ ] Import existing folders without duplicating all their files.
- [ ] Track missing/moved media clearly and allow source relocation.
- [ ] Catalog physical discs and attach existing/imported video assets to titles.
- [ ] Add a local Import DVD workflow for supported discs: scan, select title/options, convert, verify, and attach the output.
- [ ] Add persisted import-job progress, cancellation, and clear failures for unsupported discs, insufficient space, disc removal, and interruption.
- [ ] Verify an actual supported DVD import and playback after removing the disc.
- [ ] Add metadata/artwork providers if the owner wants them.

**Done when:** existing files and physical copies fit the same library model.

## 4. Move to a home server

- [ ] Choose the server, storage, and desired devices.
- [ ] Package installation and configuration for that host.
- [ ] Establish access control before enabling other-device access.
- [ ] Migrate metadata and media sources, then test backup restoration.
- [ ] Verify playback over the home network on the intended devices.

**Done when:** the collection works from the agreed devices without depending on the original browser or PC setup.

## 5. Optional growth

Subtitles and alternate audio; transcoding; TV/remote-friendly layouts; multiple profiles; remote access; richer season/episode management. Prioritize these from actual use.

## Remaining decisions

1. Which next feature should lead: existing-folder imports, physical cataloging, or guided DVD import?
2. Which real discs, video/audio formats, and subtitle options need to be supported next?

## Existing provisional artifacts

The early IndexedDB experiment is archived under prototypes/. Original hero and poster artwork are used by the interface. The private Sites draft remains unpublished; the application runs locally.
