import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat, realpath } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { createDatabase } from './database.mjs';
import { createDiskSource, MediaError } from './media/disk-source.mjs';
import { createConversionManager } from './media/conversion.mjs';
import { createCatalog, readCatalogCsv } from './metadata/catalog.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = '1.0.0';
const JSON_LIMIT = 64 * 1024;
const PALETTES = ['amber', 'teal', 'violet', 'forest', 'rose', 'blue'];
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.csv': 'text/csv; charset=utf-8' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function sendJson(response, status, value, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
    'Cache-Control': 'no-store', ...headers });
  response.end(body);
}

function decodeHeader(request, name, required = false) {
  const header = request.headers[name];
  if (!header && !required) return null;
  if (typeof header !== 'string' || !header) throw new MediaError(400, 'missing_header', `The ${name} header is required.`);
  try { return decodeURIComponent(header); } catch { throw new MediaError(400, 'invalid_header', `The ${name} header is not valid URI-encoded text.`); }
}

function uploadLength(request) {
  const value = request.headers['content-length'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new MediaError(400, 'invalid_length', 'The upload length is invalid.');
  return Number(value);
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new MediaError(415, 'json_required', 'Send metadata as application/json.');
  }
  if (uploadLength(request) > JSON_LIMIT) throw new MediaError(413, 'body_too_large', 'The metadata request is too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new MediaError(413, 'body_too_large', 'The metadata request is too large.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new MediaError(400, 'invalid_json', 'The metadata request contains invalid JSON.'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new MediaError(400, 'invalid_metadata', 'Provide a JSON object with the fields to change.');
  return value;
}

function validatePatch(input) {
  const editable = ['title', 'category', 'year', 'description', 'palette', 'watchlist', 'position', 'duration', 'completed', 'poster'];
  const keys = Object.keys(input);
  if (!keys.length || keys.some((key) => !editable.includes(key))) throw new MediaError(400, 'invalid_metadata', 'The request contains an unknown field or no changes.');
  const changes = {};
  for (const key of keys) {
    const value = input[key];
    let valid = true;
    if (key === 'title') valid = typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
    else if (key === 'category') valid = ['movie', 'tv', 'home'].includes(value);
    else if (key === 'year') valid = value === null || (Number.isInteger(value) && value >= 1888 && value <= new Date().getFullYear() + 10);
    else if (key === 'description') valid = typeof value === 'string' && value.length <= 10000 && !value.includes('\0');
    else if (key === 'palette') valid = PALETTES.includes(value);
    else if (['watchlist', 'completed'].includes(key)) valid = typeof value === 'boolean';
    else if (['position', 'duration'].includes(key)) valid = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 315360000;
    else if (key === 'poster') valid = value === null;
    if (!valid) throw new MediaError(400, 'invalid_metadata', `The ${key} field has an invalid value.`);
    if (key !== 'poster') changes[key] = key === 'title' ? value.trim() : value;
  }
  return { changes, clearPoster: Object.hasOwn(input, 'poster') };
}

function requestPath(request) {
  const raw = request.url?.split('?')[0];
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) throw new MediaError(400, 'invalid_path', 'The request path is invalid.');
  let pathname;
  try { pathname = decodeURIComponent(raw); } catch { throw new MediaError(400, 'invalid_path', 'The request path is invalid.'); }
  if (/[\\\x00-\x1f\x7f]/.test(pathname) || pathname.split('/').some((part) => part === '..' || part === '.')) {
    throw new MediaError(403, 'invalid_path', 'That file is outside the application.');
  }
  return pathname;
}

function requireLocalRequest(request, server) {
  const peer = request.socket.remoteAddress;
  if (peer !== '127.0.0.1' && peer !== '::1' && peer !== '::ffff:127.0.0.1') {
    throw new MediaError(403, 'local_only', 'Movies R Sap only accepts requests from this computer.');
  }
  const host = request.headers.host;
  if (typeof host !== 'string' || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) {
    throw new MediaError(403, 'local_only', 'Movies R Sap only accepts requests to this computer.');
  }
  const target = new URL(`http://${host}`);
  const port = Number(target.port || 80);
  if (port !== server.address()?.port) throw new MediaError(403, 'invalid_host', 'Use the local address shown when the app starts.');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== target.origin) {
      throw new MediaError(403, 'foreign_origin', 'Changes must come from this app’s own browser page.');
    }
    // Origin may be absent in command-line/native clients. Browsers also expose
    // fetch metadata, so a cross-site form cannot bypass the Origin check.
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new MediaError(403, 'foreign_origin', 'Changes must come from this app’s own browser page.');
  }
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || !size) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function acquireLock(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, 'server.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.close();
      return async () => {
        try {
          const current = JSON.parse(await readFile(lockPath, 'utf8'));
          if (current.token === token) await rm(lockPath);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let current;
      try { current = JSON.parse(await readFile(lockPath, 'utf8')); } catch {
        throw new Error('The library lock could not be read. Ensure another copy of the app is not running before removing server.lock.');
      }
      let alive = false;
      if (Number.isSafeInteger(current.pid) && current.pid > 0) {
        try { process.kill(current.pid, 0); alive = true; } catch (failure) { alive = failure.code !== 'ESRCH'; }
      }
      if (alive) throw new Error('This library is already open in another Movies R Sap process. Close that app first.');
      await rm(lockPath, { force: true });
    }
  }
  throw new Error('The library is already being opened by another process.');
}

/** Create an unbound HTTP server. Tests/launchers choose a loopback listen port. */
export async function createApp({ dataDir = path.join(projectRoot, 'data'), webDir = path.join(projectRoot, 'dist'), conversion = {} } = {}) {
  dataDir = path.resolve(dataDir);
  webDir = path.resolve(webDir);
  const releaseLock = await acquireLock(dataDir);
  let database;
  let source;
  let catalog;
  try {
    database = createDatabase(dataDir);
    catalog = createCatalog(dataDir);
    source = await createDiskSource({ dataDir });
    const knownKeys = new Set(database.exportMetadata().assets.flatMap((asset) => [asset.sourceKey, asset.posterKey].filter(Boolean)));
    for (const key of catalog.knownPosterKeys()) knownKeys.add(key);
    await source.cleanupTemporaryFiles(knownKeys);
  } catch (error) {
    catalog?.close();
    database?.close();
    await releaseLock();
    throw error;
  }

  const sockets = new Set();
  const operations = new Set();
  const titleLocks = new Map();
  let closing = false;
  let closePromise = null;

  async function exclusiveTitle(id, work) {
    const previous = titleLocks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    titleLocks.set(id, next);
    try { return await next; } finally { if (titleLocks.get(id) === next) titleLocks.delete(id); }
  }

  async function publicTitle(title) {
    if (!title) return null;
    const asset = database.getAsset(title.id);
    const info = await source.inspect(asset);
    return { ...title, available: Boolean(info) };
  }

  function requireTitle(id) {
    const title = database.getTitle(id);
    if (!title) throw new MediaError(404, 'title_not_found', 'This title is no longer in your library.');
    return title;
  }

  let conversions;
  try {
    conversions = await createConversionManager({ dataDir, source, ...conversion,
      publish: ({ temporary, input }) => exclusiveTitle(input.title.id, async () => {
        requireTitle(input.title.id);
        let asset;
        let artwork;
        try {
          const originalName = `${path.basename(input.asset.originalName, path.extname(input.asset.originalName)).slice(0, 250)}.mp4`;
          asset = await source.publishConversion(temporary, originalName);
          // A separate artwork copy makes either title independently removable.
          const posterInfo = await source.inspect(database.getAsset(input.title.id), true);
          if (posterInfo) {
            const mimeType = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(posterInfo.key)];
            artwork = await source.importPoster(source.open(posterInfo), { expectedBytes: posterInfo.size, mimeType });
            asset.posterKey = artwork.sourceKey;
          }
          const { title } = input;
          const result = database.createTitle({ id: randomUUID(), title: `${title.title.slice(0, 193)} (MP4)`,
            category: title.category, year: title.year, description: title.description, palette: title.palette,
            duration: title.duration, watchlist: title.watchlist, position: 0, completed: false }, asset);
          await Promise.all([source.confirmPublication(asset), source.confirmPublication(artwork)])
            .catch((error) => console.error('Conversion journal cleanup failed:', error.message));
          return result;
        } catch (error) {
          for (const publication of [artwork, asset].filter(Boolean)) {
            try { await source.removeKey(publication.sourceKey); await source.confirmPublication(publication); } catch { /* Restart cleanup retries journaled files. */ }
          }
          throw error;
        }
      }) });
  } catch (error) {
    catalog.close();
    database.close();
    await releaseLock();
    throw error;
  }

  async function streamAsset(request, response, id, poster = false) {
    requireTitle(id);
    const asset = database.getAsset(id);
    const info = await source.inspect(asset, poster);
    if (!info) throw new MediaError(404, poster ? 'poster_not_found' : 'media_unavailable', poster ? 'No artwork is saved for this title.' : 'This video file is missing. Restore it from backup or add the original video again.');
    const etag = `"${info.size.toString(16)}-${Math.trunc(info.modifiedAt.getTime()).toString(16)}"`;
    const mimeType = poster ? ({ '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(info.key)] || 'application/octet-stream') : asset.mimeType;
    const headers = { 'Content-Type': mimeType, 'Accept-Ranges': 'bytes', 'Content-Length': info.size,
      'Cache-Control': poster ? 'private, no-cache' : 'private, max-age=0, must-revalidate',
      'Last-Modified': info.modifiedAt.toUTCString(), ETag: etag };
    let range = null;
    if (request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === etag || request.headers['if-range'] === info.modifiedAt.toUTCString())) {
      range = parseRange(request.headers.range, info.size);
      if (!range) {
        sendJson(response, 416, { error: 'invalid_range', message: 'The requested video range is not available.' }, { 'Content-Range': `bytes */${info.size}`, 'Accept-Ranges': 'bytes' });
        return;
      }
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
      headers['Content-Length'] = range.end - range.start + 1;
    }
    if (!poster) headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(asset.originalName).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`;
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === 'HEAD' || !info.size) { response.end(); return; }
    await pipeline(source.open(info, range), response);
  }

  async function serveStatic(request, response, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const extension = path.extname(relative).toLowerCase();
    const topLevel = ['index.html', 'app.js', 'api.js', 'icons.js', 'styles.css', 'favicon.ico'];
    if (!Object.hasOwn(STATIC_TYPES, extension) || (!topLevel.includes(relative) && !relative.startsWith('assets/'))) {
      throw new MediaError(404, 'not_found', 'This application file does not exist.');
    }
    const target = path.resolve(webDir, relative);
    let resolved;
    let root;
    let info;
    try {
      [resolved, root] = await Promise.all([realpath(target), realpath(webDir)]);
      const boundary = path.relative(root, resolved);
      if (boundary === '..' || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) throw new MediaError(403, 'invalid_path', 'That file is outside the application.');
      info = await stat(resolved);
      if (!info.isFile()) throw new MediaError(404, 'not_found', 'This application file does not exist.');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new MediaError(404, 'not_found', 'This application file does not exist.');
      throw error;
    }
    response.writeHead(200, { 'Content-Type': STATIC_TYPES[extension], 'Content-Length': info.size,
      'Cache-Control': extension === '.html' || extension === '.js' || extension === '.css' ? 'no-cache' : 'public, max-age=86400' });
    if (request.method === 'HEAD') { response.end(); return; }
    await pipeline(createReadStream(resolved), response);
  }

  async function handle(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', CSP);
    requireLocalRequest(request, server);
    if (closing) throw new MediaError(503, 'shutting_down', 'The app is closing. Start it again to use your library.');
    const pathname = requestPath(request);
    const method = request.method;
    if (pathname === '/api/health' && method === 'GET') { sendJson(response, 200, { ok: true }); return; }
    if (pathname === '/api/catalog' && method === 'GET') { sendJson(response, 200, catalog.status()); return; }
    if (pathname === '/api/catalog/import' && method === 'POST') {
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'text/csv') {
        throw new MediaError(415, 'csv_required', 'Import the catalog as a UTF-8 CSV file.');
      }
      sendJson(response, 200, catalog.importCsv(await readCatalogCsv(request, uploadLength(request))));
      return;
    }
    if (pathname === '/api/catalog/search' && method === 'POST') {
      sendJson(response, 200, catalog.search(await readJson(request)));
      return;
    }
    if (pathname === '/api/catalog/posters' && method === 'POST') {
      const filename = catalog.requirePosterFilename(decodeHeader(request, 'x-file-name', true));
      const mimeType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
      const poster = await source.importPoster(request, { expectedBytes: uploadLength(request), mimeType });
      let committed = false;
      try {
        const oldKey = catalog.setPoster(filename, poster.sourceKey);
        committed = true;
        await source.confirmPublication(poster).catch((error) => console.error('Catalog artwork journal cleanup failed:', error.message));
        if (oldKey) await source.removeKey(oldKey).catch((error) => console.error('Catalog artwork cleanup failed:', error.message));
        sendJson(response, 200, { filename, ...catalog.status() });
      } catch (error) {
        if (!committed) {
          try { await source.removeKey(poster.sourceKey); await source.confirmPublication(poster); } catch { /* The publication journal retries cleanup on restart. */ }
        }
        throw error;
      }
      return;
    }
    const catalogPoster = /^\/api\/catalog\/items\/([A-Za-z0-9_-]{1,128})\/poster$/.exec(pathname);
    if (catalogPoster && ['GET', 'HEAD'].includes(method)) {
      const key = catalog.getPosterKey(catalogPoster[1]);
      const info = key && await source.inspect({ sourceKey: key });
      if (!info) throw new MediaError(404, 'catalog_poster_not_found', 'No local cover image is saved for this catalog movie.');
      const mimeType = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(info.key)];
      response.writeHead(200, { 'Content-Type': mimeType, 'Content-Length': info.size, 'Cache-Control': 'private, no-cache' });
      if (method === 'HEAD') response.end();
      else await pipeline(source.open(info), response);
      return;
    }
    if (pathname === '/api/conversion' && method === 'GET') { sendJson(response, 200, conversions.capability()); return; }
    if (pathname === '/api/conversion/jobs' && method === 'GET') { sendJson(response, 200, conversions.list()); return; }
    const conversionCancel = /^\/api\/conversion\/jobs\/([A-Za-z0-9_-]{1,128})\/cancel$/.exec(pathname);
    if (conversionCancel && method === 'POST') {
      const input = await readJson(request);
      if (Object.keys(input).length) throw new MediaError(400, 'invalid_conversion', 'Cancel does not accept conversion options.');
      sendJson(response, 200, await conversions.cancel(conversionCancel[1]));
      return;
    }
    if (pathname === '/api/settings' && method === 'GET') {
      const titles = database.listTitles();
      const inspected = await Promise.all(titles.map((title) => source.inspect(database.getAsset(title.id))));
      const free = await source.freeBytes();
      sendJson(response, 200, { libraryPath: dataDir, mediaPath: source.mediaPath,
        usageBytes: inspected.reduce((sum, item) => sum + (item?.size || 0), 0), totalTitles: titles.length,
        ...(free === null ? {} : { freeBytes: free }), version: VERSION, localOnly: true });
      return;
    }
    if (pathname === '/api/titles' && method === 'GET') {
      sendJson(response, 200, await Promise.all(database.listTitles().map(publicTitle)));
      return;
    }
    if (pathname === '/api/export' && method === 'GET') {
      sendJson(response, 200, database.exportMetadata(), { 'Content-Disposition': `attachment; filename="movies-r-sap-metadata-${new Date().toISOString().slice(0, 10)}.json"` });
      return;
    }
    if (pathname === '/api/uploads' && method === 'POST') {
      const originalName = decodeHeader(request, 'x-file-name', true);
      const desiredTitle = decodeHeader(request, 'x-title');
      const defaultTitle = originalName.replace(/\.[^.]*$/, '').replace(/[._]/g, ' ').trim().slice(0, 200) || 'Untitled video';
      const title = desiredTitle === null ? defaultTitle : validatePatch({ title: desiredTitle }).changes.title;
      const asset = await source.importVideo(request, { originalName, expectedBytes: uploadLength(request) });
      let created;
      try {
        created = database.createTitle({ id: randomUUID(), title, palette: PALETTES[Math.floor(Math.random() * PALETTES.length)] }, asset);
      } catch (error) {
        try { await source.removeKey(asset.sourceKey); await source.confirmPublication(asset); } catch { /* journal retries cleanup on restart */ }
        throw error;
      }
      await source.confirmPublication(asset).catch((error) => console.error('Upload journal cleanup failed:', error.message));
      sendJson(response, 201, created);
      return;
    }

    const match = /^\/api\/titles\/([A-Za-z0-9_-]{1,128})(?:\/(stream|poster|conversions|catalog))?$/.exec(pathname);
    if (match) {
      const [, id, action] = match;
      if (action === 'catalog' && method === 'POST') {
        const input = await readJson(request);
        if (Object.keys(input).length !== 1 || typeof input.catalogId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.catalogId)) {
          throw new MediaError(400, 'invalid_catalog', 'Choose a movie from the local catalog.');
        }
        const result = await exclusiveTitle(id, async () => {
          requireTitle(id);
          const selected = catalog.get(input.catalogId);
          if (!selected) throw new MediaError(404, 'catalog_not_found', 'This movie is no longer in the local catalog.');
          const changes = validatePatch({ title: selected.title,
            ...(selected.year === null ? {} : { year: selected.year }),
            ...(selected.description ? { description: selected.description } : {}) }).changes;
          let artwork;
          let committed = false;
          try {
            const posterKey = catalog.getPosterKey(selected.id);
            if (posterKey) {
              const info = await source.inspect({ sourceKey: posterKey });
              if (!info) throw new MediaError(404, 'catalog_poster_not_found', 'This catalog cover image is missing. Import its image again before applying it.');
              const mimeType = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(info.key)];
              artwork = await source.importPoster(source.open(info), { expectedBytes: info.size, mimeType });
            }
            const oldPoster = artwork ? database.getAsset(id)?.posterKey : null;
            const updated = database.applyCatalogMetadata(id, changes, artwork?.sourceKey);
            committed = true;
            await source.confirmPublication(artwork).catch((error) => console.error('Matched artwork journal cleanup failed:', error.message));
            if (oldPoster) await source.removeKey(oldPoster).catch((error) => console.error('Artwork cleanup failed:', error.message));
            return publicTitle(updated);
          } catch (error) {
            if (artwork && !committed) {
              try { await source.removeKey(artwork.sourceKey); await source.confirmPublication(artwork); } catch { /* The publication journal retries cleanup on restart. */ }
            }
            throw error;
          }
        });
        sendJson(response, 200, result);
        return;
      }
      if (action === 'conversions' && method === 'POST') {
        const input = await readJson(request);
        if (Object.keys(input).length) throw new MediaError(400, 'invalid_conversion', 'This converter uses the app’s fixed MP4 profile; custom paths and options are not accepted.');
        const job = await exclusiveTitle(id, async () => {
          const title = requireTitle(id);
          const asset = database.getAsset(id);
          const info = await source.inspect(asset);
          if (!info) throw new MediaError(404, 'media_unavailable', 'The original video file is missing. Restore it before converting.');
          return conversions.start({ ...info, title, asset });
        });
        sendJson(response, 202, job);
        return;
      }
      if (action === 'stream' && ['GET', 'HEAD'].includes(method)) { await streamAsset(request, response, id); return; }
      if (action === 'poster' && ['GET', 'HEAD'].includes(method)) { await streamAsset(request, response, id, true); return; }
      if (!action && method === 'GET') { sendJson(response, 200, await publicTitle(requireTitle(id))); return; }
      if (!action && method === 'PATCH') {
        const { changes, clearPoster } = validatePatch(await readJson(request));
        const result = await exclusiveTitle(id, async () => {
          requireTitle(id);
          const oldPoster = clearPoster ? database.getAsset(id)?.posterKey : null;
          const updated = database.patchTitle(id, changes, clearPoster);
          if (oldPoster) await source.removeKey(oldPoster).catch((error) => console.error('Artwork cleanup failed:', error.message));
          return publicTitle(updated);
        });
        sendJson(response, 200, result);
        return;
      }
      if (!action && method === 'DELETE') {
        await exclusiveTitle(id, async () => {
          requireTitle(id);
          if (conversions.isUsing(id)) throw new MediaError(409, 'conversion_active', 'Wait for this movie’s conversion to finish or cancel it before removing the original.');
          const asset = database.getAsset(id);
          const staged = await source.stageRemoval(asset);
          try { database.deleteTitle(id); } catch (error) { await staged.rollback(); throw error; }
          // If cleanup is interrupted, the journal finishes it at next startup.
          await staged.commit().catch((error) => console.error('Deleted-file cleanup failed:', error.message));
        });
        sendJson(response, 200, { ok: true });
        return;
      }
      if (action === 'poster' && method === 'POST') {
        requireTitle(id);
        const mimeType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
        const poster = await source.importPoster(request, { expectedBytes: uploadLength(request), mimeType });
        try {
          const updated = await exclusiveTitle(id, async () => {
            requireTitle(id);
            const oldPoster = database.getAsset(id)?.posterKey;
            const result = database.setPoster(id, poster.sourceKey);
            await source.confirmPublication(poster).catch((error) => console.error('Artwork journal cleanup failed:', error.message));
            if (oldPoster) await source.removeKey(oldPoster).catch((error) => console.error('Artwork cleanup failed:', error.message));
            return publicTitle(result);
          });
          sendJson(response, 200, updated);
        } catch (error) {
          try { await source.removeKey(poster.sourceKey); await source.confirmPublication(poster); } catch { /* journal retries cleanup on restart */ }
          throw error;
        }
        return;
      }
      throw new MediaError(405, 'method_not_allowed', 'This action is not supported.');
    }
    if (pathname.startsWith('/api/')) throw new MediaError(404, 'not_found', 'This API endpoint does not exist.');
    if (!['GET', 'HEAD'].includes(method)) throw new MediaError(405, 'method_not_allowed', 'This action is not supported.');
    await serveStatic(request, response, pathname);
  }

  const server = http.createServer((request, response) => {
    const operation = handle(request, response).catch((error) => {
      if (response.headersSent) {
        if (!response.destroyed) response.destroy(error);
        return;
      }
      const known = error instanceof MediaError;
      if (!known && error.code !== 'ECONNRESET' && error.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !request.aborted) console.error('Request failed:', error.message);
      sendJson(response, known ? error.status : 500, { error: known ? error.code : 'server_error',
        message: known ? error.message : 'The operation could not be completed. Check the app terminal and try again.' });
      // Rejected uploads may still have a body; drain it without retaining data.
      if (!request.complete && !request.destroyed) request.resume();
    });
    operations.add(operation);
    operation.finally(() => operations.delete(operation));
  });
  // Large local movie copies may take longer than Node's default five minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  return {
    server, dataDir, webDir, mediaPath: source.mediaPath, database, source, conversions, catalog,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await new Promise((resolve) => {
          const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 2000);
          timer.unref();
          server.close(() => { clearTimeout(timer); resolve(); });
          server.closeIdleConnections();
        });
        await Promise.allSettled([...operations]);
        await conversions.close();
        catalog.close();
        database.close();
        await releaseLock();
      })();
      return closePromise;
    },
  };
}
