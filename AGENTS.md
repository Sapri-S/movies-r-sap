# Project working rules

## Current phase

Implementation authorized by the user. A Windows desktop app is required alongside the optional browser companion. Build and verify the self-contained executable for this PC. Keep home-server access and integrated DVD conversion in later milestones. The user authorized a public GitHub source repository. Keep personal libraries and local service settings private; do not deploy the media application.

## Before changing the app

- Read `README.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, and the active milestone in `docs/ROADMAP.md`.
- Preserve existing user changes and media files.
- Resolve routine implementation details within the agreed scope. Ask about changes to product scope, audience, or storage ownership.

## Engineering boundaries

- Keep UI, HTTP handlers, domain logic, metadata persistence, and media access in separate modules.
- Store videos on disk behind a media-source boundary. Do not make browser storage the primary movie library.
- Use stable media IDs and database migrations. Keep machine-specific absolute paths out of portable library records.
- Keep secrets and local settings out of source control. Never commit uploaded videos or runtime databases.
- Desktop data belongs in the user's application-data folder, outside the packaged app. Do not bundle movies, test libraries, or development tools in the distribution.
- Keep the first release's media library and service local. Enabling LAN or remote access is a separate agreed milestone.
- Do not add a service, integration, or abstraction until an approved feature needs it.
- Keep future capabilities clearly labeled; do not simulate a working server connection or playable media.

## Verification and documentation

- Check the actual behavior changed. Use meaningful tests for persistence, streaming, upload failure handling, and authorized file access.
- Verify the library with a real small test video before calling playback complete.
- Record material decisions in `docs/ARCHITECTURE.md` and milestone progress in `docs/ROADMAP.md`.
- Keep setup commands in `README.md` accurate once the app is runnable.
- Report what works, how it was checked, and any remaining limitations.
