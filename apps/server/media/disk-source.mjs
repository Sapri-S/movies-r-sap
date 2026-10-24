import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, stat, statfs, realpath, rename, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_VIDEO_BYTES = 100 * 1024 ** 3;
export const MAX_POSTER_BYTES = 10 * 1024 ** 2;
const DISK_RESERVE = 16 * 1024 ** 2;
const MIME_TYPES = Object.freeze({ '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' });

export class MediaError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'MediaError';
    this.status = status;
    this.code = code;
  }
}

export function sanitizeOriginalName(value) {
  // Original names are display metadata. Disk filenames are always generated.
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\\/\x00-\x1f\x7f]/.test(value)) {
    throw new MediaError(400, 'invalid_filename', 'Choose a file with a valid filename.');
  }
  const name = value.replaceAll('\\', '/').split('/').pop().trim();
  if (!name || name === '.' || name === '..' || name.length > 255) {
    throw new MediaError(400, 'invalid_filename', 'Choose a file with a filename of 255 characters or fewer.');
  }
  return name;
}

function validVideoSignature(sample, extension) {
  if (sample.length < 12) return false;
  if (extension === '.webm' || extension === '.mkv') return sample.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (extension === '.avi') return sample.toString('ascii', 0, 4) === 'RIFF' && sample.toString('ascii', 8, 12) === 'AVI ';
  return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(sample.toString('ascii', 4, 8));
}

function posterFormat(sample) {
  if (sample.length >= 8 && sample.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: '.png', mimeType: 'image/png' };
  if (sample.length >= 3 && sample[0] === 255 && sample[1] === 216 && sample[2] === 255) return { extension: '.jpg', mimeType: 'image/jpeg' };
  if (sample.length >= 12 && sample.toString('ascii', 0, 4) === 'RIFF' && sample.toString('ascii', 8, 12) === 'WEBP') return { extension: '.webp', mimeType: 'image/webp' };
  return null;
}

/**
 * The sole media source in V1: app-owned disk copies. Future sources implement
 * inspect(asset), open(asset, range), and their supported import/remove actions.
 * APIs pass stable source keys; an HTTP caller never chooses a filesystem path.
 */
export async function createDiskSource({ dataDir }) {
  const mediaPath = path.resolve(dataDir, 'media');
  const tempPath = path.resolve(dataDir, 'tmp');
  await Promise.all([mkdir(path.join(mediaPath, 'videos'), { recursive: true }),
    mkdir(path.join(mediaPath, 'posters'), { recursive: true }), mkdir(tempPath, { recursive: true })]);
  const realRoot = await realpath(mediaPath);

  function resolveKey(key) {
    if (typeof key !== 'string' || !key || key.includes('\\') || key.includes('\0') || path.posix.isAbsolute(key)) {
      throw new MediaError(400, 'invalid_asset', 'The media reference is invalid.');
    }
    const target = path.resolve(mediaPath, key);
    const relative = path.relative(mediaPath, target);
    if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new MediaError(400, 'invalid_asset', 'The media reference is outside the managed library.');
    }
    return target;
  }

  async function safeExistingPath(key) {
    const target = resolveKey(key);
    const resolved = await realpath(target);
    const relative = path.relative(realRoot, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new MediaError(403, 'invalid_asset', 'The media reference is outside the managed library.');
    }
    return target;
  }

  async function freeBytes() {
    try {
      const space = await statfs(mediaPath, { bigint: true });
      const bytes = space.bavail * space.bsize;
      return Number(bytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bytes);
    } catch (error) {
      if (error.code === 'ENOSYS' || error.code === 'ENOTSUP') return null;
      throw error;
    }
  }

  async function receive(request, { limit, expectedBytes, validate, finalKey }) {
    if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) {
      throw new MediaError(400, 'invalid_length', 'The upload length is invalid.');
    }
    if (expectedBytes === 0) throw new MediaError(400, 'empty_file', 'The selected file is empty.');
    if (expectedBytes > limit) throw new MediaError(413, 'file_too_large', `This upload exceeds the ${limit === MAX_VIDEO_BYTES ? '100 GB' : '10 MB'} limit.`);
    const free = await freeBytes();
    if (free !== null && free < (expectedBytes || 0) + DISK_RESERVE) {
      throw new MediaError(507, 'disk_full', 'There is not enough free space in your library folder.');
    }
    const temporaryFile = path.join(tempPath, `upload-${randomUUID()}.part`);
    let size = 0;
    let sample = Buffer.alloc(0);
    let nextSpaceCheck = 64 * 1024 ** 2;
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > limit) {
          callback(new MediaError(413, 'file_too_large', 'The upload is larger than the allowed limit.'));
          return;
        }
        if (sample.length < 32) sample = Buffer.concat([sample, chunk.subarray(0, 32 - sample.length)]);
        if (size >= nextSpaceCheck) {
          nextSpaceCheck = size + 64 * 1024 ** 2;
          freeBytes().then((remaining) => {
            if (remaining !== null && remaining < DISK_RESERVE) callback(new MediaError(507, 'disk_full', 'Your library disk is full. Free up space and try again.'));
            else callback(null, chunk);
          }, callback);
        } else callback(null, chunk);
      },
    });
    let destination = null;
    let publicationName = null;
    const onInputError = (error) => meter.destroy(error);
    const onAborted = () => meter.destroy(new MediaError(400, 'incomplete_upload', 'The upload was interrupted. Try adding the file again.'));
    const detachInput = () => {
      request.removeListener('error', onInputError);
      request.removeListener('aborted', onAborted);
      request.removeListener('end', detachInput);
      request.removeListener('close', detachInput);
    };
    try {
      if (request.aborted || (request.destroyed && !request.complete)) throw new MediaError(400, 'incomplete_upload', 'The upload was interrupted. Try adding the file again.');
      request.on('error', onInputError);
      request.once('aborted', onAborted);
      request.once('end', detachInput);
      request.once('close', detachInput);
      // Do not include IncomingMessage in pipeline: destroying it on an oversized
      // chunked body also destroys the response socket, hiding the useful error.
      const writing = pipeline(meter, createWriteStream(temporaryFile, { flags: 'wx', mode: 0o600, flush: true }));
      request.pipe(meter);
      await writing;
      if (!size) throw new MediaError(400, 'empty_file', 'The selected file is empty.');
      if (expectedBytes !== undefined && size !== expectedBytes) throw new MediaError(400, 'incomplete_upload', 'The upload was interrupted. Try adding the file again.');
      const detail = validate(sample);
      const key = typeof finalKey === 'function' ? finalKey(detail) : finalKey;
      destination = resolveKey(key);
      publicationName = `publish-${randomUUID()}.json`;
      await writeFile(path.join(tempPath, publicationName), JSON.stringify({ sourceKey: key }), { flag: 'wx', mode: 0o600, flush: true });
      await rename(temporaryFile, destination);
      return { sourceId: 'local', sourceKey: key, fileSize: size, publicationName, ...detail };
    } catch (error) {
      await rm(temporaryFile, { force: true }).catch(() => {});
      if (destination) await rm(destination, { force: true }).catch(() => {});
      if (publicationName) await rm(path.join(tempPath, publicationName), { force: true }).catch(() => {});
      if (error.code === 'ENOSPC' || error.code === 'EDQUOT') throw new MediaError(507, 'disk_full', 'Your library disk is full. Free up space and try again.');
      throw error;
    } finally {
      request.unpipe(meter);
      if (request.complete || request.destroyed) detachInput();
    }
  }

  const source = {
    id: 'local',
    mediaPath,
    tempPath,
    freeBytes,
    async confirmPublication(asset) {
      if (asset?.publicationName && /^publish-[a-f0-9-]+\.json$/.test(asset.publicationName)) {
        await rm(path.join(tempPath, asset.publicationName), { force: true });
      }
    },
    async publishConversion(temporaryFile, originalName) {
      // Only an internally generated job output can enter the media directory.
      const name = path.basename(temporaryFile);
      if (!/^conversion-[a-f0-9-]{36}\.mp4\.part$/.test(name) || path.resolve(temporaryFile) !== path.join(tempPath, name)) {
        throw new MediaError(400, 'invalid_conversion', 'The conversion output reference is invalid.');
      }
      const info = await stat(temporaryFile);
      if (!info.isFile() || info.size < 12 || info.size > MAX_VIDEO_BYTES) throw new MediaError(415, 'invalid_conversion', 'The converter did not produce a valid video file.');
      const handle = await open(temporaryFile, 'r');
      const sample = Buffer.alloc(32);
      try { await handle.read(sample, 0, sample.length, 0); } finally { await handle.close(); }
      if (!validVideoSignature(sample, '.mp4')) throw new MediaError(415, 'invalid_conversion', 'The converter did not produce a valid MP4 file.');
      const id = randomUUID();
      const key = `videos/${id}.mp4`;
      const publicationName = `publish-${randomUUID()}.json`;
      await writeFile(path.join(tempPath, publicationName), JSON.stringify({ sourceKey: key }), { flag: 'wx', mode: 0o600, flush: true });
      try { await rename(temporaryFile, resolveKey(key)); } catch (error) {
        await rm(path.join(tempPath, publicationName), { force: true }).catch(() => {});
        throw error;
      }
      return { id, sourceId: 'local', sourceKey: key, fileSize: info.size, publicationName,
        mimeType: 'video/mp4', originalName: sanitizeOriginalName(originalName), posterKey: null };
    },
    async importVideo(request, { originalName, expectedBytes }) {
      const name = sanitizeOriginalName(originalName);
      const extension = path.extname(name).toLowerCase();
      if (!Object.hasOwn(MIME_TYPES, extension)) throw new MediaError(415, 'unsupported_file', 'Choose an MP4, M4V, WebM, MOV, MKV, or AVI video file. Browser playback depends on its codecs.');
      const id = randomUUID();
      const asset = await receive(request, {
        limit: MAX_VIDEO_BYTES,
        expectedBytes,
        finalKey: `videos/${id}${extension}`,
        validate(sample) {
          if (!validVideoSignature(sample, extension)) throw new MediaError(415, 'invalid_video', 'This file does not appear to contain the selected video format. Choose a valid video file.');
          return { mimeType: MIME_TYPES[extension] };
        },
      });
      return { ...asset, id, originalName: name, posterKey: null };
    },
    async importPoster(request, { expectedBytes, mimeType }) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new MediaError(415, 'unsupported_poster', 'Choose a JPEG, PNG, or WebP image.');
      const id = randomUUID();
      return receive(request, {
        limit: MAX_POSTER_BYTES,
        expectedBytes,
        finalKey: (detail) => `posters/${id}${detail.extension}`,
        validate(sample) {
          const format = posterFormat(sample);
          if (!format || format.mimeType !== mimeType) throw new MediaError(415, 'invalid_poster', 'The image contents do not match the selected image format.');
          return format;
        },
      });
    },
    async inspect(asset, poster = false) {
      const key = poster ? asset?.posterKey : asset?.sourceKey;
      if (!key) return null;
      try {
        const filePath = await safeExistingPath(key);
        const info = await stat(filePath);
        return info.isFile() ? { filePath, size: info.size, modifiedAt: info.mtime, key } : null;
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return null;
        throw error;
      }
    },
    open(fileInfo, range) {
      return createReadStream(fileInfo.filePath, range ? { start: range.start, end: range.end } : {});
    },
    async removeKey(key) {
      if (!key) return;
      // A symlink is never followed outside the managed root for deletion.
      let target;
      try { target = await safeExistingPath(key); } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      await rm(target, { force: true });
    },
    async stageRemoval(asset) {
      const operationId = randomUUID();
      const entries = [asset?.sourceKey, asset?.posterKey].filter(Boolean).map((key, index) => ({
        key, temporaryName: `delete-${operationId}-${index}.part`,
      }));
      const journalPath = path.join(tempPath, `delete-${operationId}.json`);
      await writeFile(journalPath, JSON.stringify(entries), { flag: 'wx', mode: 0o600, flush: true });
      const staged = [];
      try {
        for (const { key, temporaryName } of entries) {
          let filePath;
          try { filePath = await safeExistingPath(key); } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
          }
          const temporaryFile = path.join(tempPath, temporaryName);
          await rename(filePath, temporaryFile);
          staged.push({ filePath, temporaryFile });
        }
      } catch (error) {
        let restored = true;
        for (const item of staged.reverse()) await rename(item.temporaryFile, item.filePath).catch(() => { restored = false; });
        if (restored) await rm(journalPath, { force: true });
        throw error;
      }
      return {
        async commit() {
          await Promise.all(staged.map(({ temporaryFile }) => rm(temporaryFile, { force: true })));
          await rm(journalPath, { force: true });
        },
        async rollback() {
          for (const item of staged.reverse()) await rename(item.temporaryFile, item.filePath);
          await rm(journalPath, { force: true });
        },
      };
    },
    async cleanupTemporaryFiles(knownKeys = new Set()) {
      // Called once at startup. A process lock prevents another active server
      // from having its in-flight upload removed by a second app instance.
      const entries = await readdir(tempPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && /^publish-[a-f0-9-]+\.json$/.test(entry.name)) {
          const journalPath = path.join(tempPath, entry.name);
          const journal = JSON.parse(await readFile(journalPath, 'utf8'));
          if (!knownKeys.has(journal.sourceKey)) await source.removeKey(journal.sourceKey);
          await rm(journalPath, { force: true });
        }
        if (entry.isFile() && /^delete-[a-f0-9-]+\.json$/.test(entry.name)) {
          const journalPath = path.join(tempPath, entry.name);
          const journal = JSON.parse(await readFile(journalPath, 'utf8'));
          if (!Array.isArray(journal)) throw new Error('An interrupted deletion journal is invalid. Preserve your library and restore from backup.');
          for (const item of journal) {
            if (!/^delete-[a-f0-9-]+\.part$/.test(item.temporaryName)) throw new Error('An interrupted deletion journal is invalid.');
            const target = resolveKey(item.key);
            const temporaryFile = path.join(tempPath, item.temporaryName);
            if (knownKeys.has(item.key)) {
              try {
                await stat(target);
                await rm(temporaryFile, { force: true });
              } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                await rename(temporaryFile, target).catch((failure) => { if (failure.code !== 'ENOENT') throw failure; });
              }
            } else await rm(temporaryFile, { force: true });
          }
          await rm(journalPath, { force: true });
        }
        if (entry.isFile() && /^upload-[a-f0-9-]+\.part$/.test(entry.name)) {
          await rm(path.join(tempPath, entry.name), { force: true });
        }
        if (entry.isFile() && /^conversion-[a-f0-9-]{36}\.mp4\.part$/.test(entry.name)) {
          await rm(path.join(tempPath, entry.name), { force: true });
        }
      }
      // Existing files without a journal are preserved even if metadata was
      // lost/restored. An untracked file alone is never evidence of an upload.
    },
  };
  return source;
}
