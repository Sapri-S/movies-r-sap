# Video conversion engine

Movies R Sap runs FFmpeg as a separate local process to create compatible MP4 copies. It does not modify FFmpeg. Conversion does not send media to an external service.

- FFmpeg: <https://ffmpeg.org/>
- Binary provider: <https://www.gyan.dev/ffmpeg/builds/>
- Download package: `ffmpeg-static` 5.3.0, <https://github.com/eugeneware/ffmpeg-static>
- Bundled Windows engine: FFmpeg 6.1.1 essentials build, GPL version 3.
- FFmpeg source revision reported by that build: <https://github.com/FFmpeg/FFmpeg/commit/e38092ef93>
- Binary release, build provenance, and license: <https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1>

The Windows package includes `resources/ffmpeg/LICENSE.txt` (the complete GPLv3 license) and `resources/ffmpeg/BUILD-README.txt` (the upstream build configuration, source revision, and linked-library versions). Those files are copied unchanged from the engine distribution.

FFmpeg and its linked libraries retain their respective copyrights and licenses. Keep these notices with the engine. Any redistribution of FFmpeg binaries must comply with their license, including the applicable corresponding-source requirements; the application source repository alone is not the corresponding source for all linked FFmpeg libraries.

The `ffmpeg-static` JavaScript download package is licensed GPL-3.0-or-later; its license is available in the installed package and upstream repository. Electron, its packager, and other npm dependencies retain their own licenses in their respective packages.
