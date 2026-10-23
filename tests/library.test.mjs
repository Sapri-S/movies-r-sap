import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApp } from '../apps/server/app.mjs';

const testsRoot = dirname(fileURLToPath(import.meta.url));

// This MP4-shaped fixture verifies byte transport. Browser playback is checked
// separately with an actual encoded video; these bytes do not contain a movie.
const video = Buffer.concat([
  Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'),
  Buffer.from('000001086d646174', 'hex'),
  Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
]);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=',
  'base64',
);

async function fixture(t) {
  const root = await mkdtemp(join(testsRoot, '.runtime-'));
  const dataDir = join(root, 'library');
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Test movie library</title>');
  await writeFile(join(root, 'private.txt'), 'OUTSIDE_THE_WEB_AND_MEDIA_ROOTS');
  const env = { root, dataDir, webDir, app: null, url: '' };
  env.start = async () => {
    env.app = await createApp({ dataDir, webDir });
    await new Promise((done, reject) => {
      env.app.server.once('error', reject);
      env.app.server.listen(0, '127.0.0.1', done);
    });
    env.url = `http://127.0.0.1:${env.app.server.address().port}`;
  };
  env.stop = async () => {
    if (env.app) {
      await env.app.close();
      env.app = null;
    }
  };
  t.after(async () => {
    await env.stop();
    const cleanupTarget = resolve(root);
    assert.ok(cleanupTarget.startsWith(`${resolve(testsRoot)}${sep}.runtime-`));
    await rm(cleanupTarget, { recursive: true, force: true });
  });
  await env.start();
  return env;
}

async function json(env, path, options) {
  const response = await fetch(`${env.url}${path}`, options);
  const body = await response.json();
  return { response, body };
}

async function upload(env, name = 'A little movie.mp4', bytes = video) {
  const result = await json(env, '/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4', 'X-File-Name': encodeURIComponent(name) },
    body: bytes,
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.ok(result.body.id);
  return result.body;
}

async function patch(env, id, fields, headers = {}) {
  return json(env, `/api/titles/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(fields),
  });
}

async function regularFiles(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const names = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const name of await regularFiles(join(root, entry.name))) names.push(join(entry.name, name));
    } else if (entry.isFile()) names.push(entry.name);
  }
  return names.sort();
}

async function eventually(check, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((done) => setTimeout(done, 30));
    }
  } while (Date.now() < deadline);
  throw new Error(description, { cause: lastError });
}

function rawRequest(env, path, headers = {}) {
  return new Promise((done, reject) => {
    const req = request(env.url, { path, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => done({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a new library reports its disk location and starts empty', async (t) => {
  const env = await fixture(t);
  const health = await json(env, '/api/health');
  assert.equal(health.response.status, 200);
  const { response, body } = await json(env, '/api/settings');
  assert.equal(response.status, 200);
  assert.equal(resolve(body.libraryPath), resolve(env.dataDir));
  assert.equal(resolve(body.mediaPath), resolve(join(env.dataDir, 'media')));
  assert.equal(body.localOnly, true);
  assert.equal(body.totalTitles, 0);
  assert.equal(body.usageBytes, 0);
  assert.deepEqual((await json(env, '/api/titles')).body, []);
});

test('uploaded movie bytes and library edits survive closing and reopening the app', async (t) => {
  const env = await fixture(t);
  const name = 'A movie — café.mp4';
  const added = await upload(env, name);
  assert.equal(added.originalName, name);
  assert.equal(added.fileSize, video.length);
  assert.equal(added.mimeType, 'video/mp4');
  assert.equal(added.available, true);
  const fields = {
    title: 'Night Drive', category: 'home', year: 2022,
    description: 'An evening from my collection.', palette: 'teal',
    watchlist: true, duration: 600, position: 126.5, completed: false,
  };
  const edited = await patch(env, added.id, fields);
  assert.equal(edited.response.status, 200);
  for (const [key, value] of Object.entries(fields)) assert.equal(edited.body[key], value, key);
  await env.stop();
  await env.start();
  const { body } = await json(env, '/api/titles');
  assert.equal(body.length, 1);
  assert.equal(body[0].id, added.id);
  for (const [key, value] of Object.entries(fields)) assert.equal(body[0][key], value, key);
  const playback = await fetch(`${env.url}/api/titles/${added.id}/stream`);
  assert.equal(playback.status, 200);
  assert.deepEqual(Buffer.from(await playback.arrayBuffer()), video);
  const settings = (await json(env, '/api/settings')).body;
  assert.equal(settings.totalTitles, 1);
  assert.equal(settings.usageBytes, video.length);
  const finished = await patch(env, added.id, { completed: true, position: 600, watchlist: false });
  assert.equal(finished.response.status, 200);
  await env.stop();
  await env.start();
  const completed = (await json(env, '/api/titles')).body[0];
  assert.equal(completed.completed, true);
  assert.equal(completed.position, 600);
  assert.equal(completed.watchlist, false);
});

test('video streaming supports full, bounded, open, suffix, and HEAD requests', async (t) => {
  const env = await fixture(t);
  const item = await upload(env);
  const path = `/api/titles/${item.id}/stream`;
  for (const [range, start, end] of [
    ['bytes=0-15', 0, 15], ['bytes=16-', 16, video.length - 1],
    ['bytes=-16', video.length - 16, video.length - 1],
    ['bytes=0-999999', 0, video.length - 1],
  ]) {
    const response = await fetch(`${env.url}${path}`, { headers: { Range: range } });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${video.length}`);
    assert.equal(Number(response.headers.get('content-length')), end - start + 1);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(start, end + 1));
  }
  for (const [headers, expectedStatus, expectedLength] of [
    [{}, 200, video.length], [{ Range: 'bytes=4-11' }, 206, 8],
  ]) {
    const response = await fetch(`${env.url}${path}`, { method: 'HEAD', headers });
    assert.equal(response.status, expectedStatus);
    assert.equal(Number(response.headers.get('content-length')), expectedLength);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
});

test('unsatisfiable and malformed byte ranges fail without breaking later playback', async (t) => {
  const env = await fixture(t);
  const item = await upload(env);
  const path = `/api/titles/${item.id}/stream`;
  for (const range of [`bytes=${video.length}-`, 'bytes=20-10', 'bytes=0-1,4-5', 'bytes=oops', 'bytes=-0']) {
    const response = await fetch(`${env.url}${path}`, { headers: { Range: range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${video.length}`);
    await response.arrayBuffer();
  }
  const response = await fetch(`${env.url}${path}`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), video);
});

test('bad uploads leave no library entries or managed media files', async (t) => {
  const env = await fixture(t);
  const baseline = await regularFiles(env.app.mediaPath);
  for (const [name, bytes] of [
    ['program.exe', video], ['fake.mp4', Buffer.from('this is not a video')], ['empty.mp4', Buffer.alloc(0)],
  ]) {
    const { response, body } = await json(env, '/api/uploads', {
      method: 'POST', headers: { 'Content-Type': 'video/mp4', 'X-File-Name': encodeURIComponent(name) }, body: bytes,
    });
    assert.ok(response.status >= 400 && response.status < 500, `${name}: ${response.status}`);
    assert.equal(typeof body.message, 'string');
  }
  assert.deepEqual((await json(env, '/api/titles')).body, []);
  assert.deepEqual(await regularFiles(env.app.mediaPath), baseline);
});

test('upload filenames are display metadata and cannot select a disk destination', async (t) => {
  const env = await fixture(t);
  const outside = join(env.root, 'escape.mp4');
  const original = Buffer.from('An existing owner file must remain untouched.');
  await writeFile(outside, original);
  for (const name of ['../escape.mp4', '..\\escape.mp4']) {
    const { response } = await json(env, '/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4', 'X-File-Name': encodeURIComponent(name) },
      body: video,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await readFile(outside), original);
  }
  assert.deepEqual((await json(env, '/api/titles')).body, []);
});

test('invalid metadata edits are rejected atomically', async (t) => {
  const env = await fixture(t);
  const item = await upload(env);
  const invalid = [
    {}, { title: '' }, { title: 'x'.repeat(201) }, { category: 'documentary' },
    { year: '2024' }, { year: 1887 }, { watchlist: 'true' }, { completed: 1 },
    { position: -1 }, { duration: null }, { description: [] }, { palette: 'orange' },
    { poster: 'https://example.com/image.png' }, { sourceKey: '../../private.txt' },
    { title: 'This must not persist', year: 'invalid' },
  ];
  for (const fields of invalid) {
    const { response, body } = await patch(env, item.id, fields);
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.equal(typeof body.message, 'string');
  }
  const titles = (await json(env, '/api/titles')).body;
  assert.equal(titles.length, 1);
  assert.deepEqual(titles[0], item);
});

test('malformed edits and stale title actions return errors without changing the collection', async (t) => {
  const env = await fixture(t);
  const item = await upload(env);
  const malformed = await json(env, `/api/titles/${item.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(typeof malformed.body.message, 'string');
  const missingId = '00000000-0000-4000-8000-000000000000';
  const staleEdit = await patch(env, missingId, { title: 'Stale editor' });
  assert.equal(staleEdit.response.status, 404);
  const staleDelete = await json(env, `/api/titles/${missingId}`, { method: 'DELETE' });
  assert.equal(staleDelete.response.status, 404);
  const stalePoster = await json(env, `/api/titles/${missingId}/poster`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png,
  });
  assert.equal(stalePoster.response.status, 404);
  assert.deepEqual((await json(env, '/api/titles')).body, [item]);
});

test('poster upload, retrieval, validation, removal, and persistence use title IDs', async (t) => {
  const env = await fixture(t);
  const item = await upload(env);
  const path = `/api/titles/${item.id}/poster`;
  const { response, body } = await json(env, path, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png,
  });
  assert.equal(response.status, 200);
  assert.equal(body.poster, path);
  await env.stop();
  await env.start();
  const poster = await fetch(`${env.url}${path}`);
  assert.equal(poster.status, 200);
  assert.match(poster.headers.get('content-type'), /^image\/png/);
  assert.deepEqual(Buffer.from(await poster.arrayBuffer()), png);
  const head = await fetch(`${env.url}${path}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), png.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const invalid = await json(env, path, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('not an image'),
  });
  assert.ok(invalid.response.status >= 400 && invalid.response.status < 500);
  const unchanged = await fetch(`${env.url}${path}`);
  assert.deepEqual(Buffer.from(await unchanged.arrayBuffer()), png);
  const cleared = await patch(env, item.id, { poster: null });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.body.poster, null);
  const gone = await fetch(`${env.url}${path}`);
  assert.equal(gone.status, 404);
  await gone.arrayBuffer();
});

test('a metadata export is portable and includes source mappings without absolute paths', async (t) => {
  const env = await fixture(t);
  const item = await upload(env);
  await patch(env, item.id, { watchlist: true, position: 42, duration: 100 });
  const { response, body } = await json(env, '/api/export');
  assert.equal(response.status, 200);
  assert.equal(body.format, 'movies-r-sap');
  assert.equal(body.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(body.exportedAt)));
  assert.equal(body.titles.length, 1);
  assert.equal(body.titles[0].id, item.id);
  assert.equal(body.titles[0].watchlist, true);
  assert.equal(body.titles[0].position, 42);
  assert.ok(body.sources.some((source) => source.id === 'local' && source.root === 'media'));
  assert.equal(body.assets.length, 1);
  for (const asset of body.assets) {
    assert.equal(typeof asset.sourceKey, 'string');
    assert.equal(isAbsolute(asset.sourceKey), false);
    assert.equal(asset.sourceKey.split(/[\\/]/).includes('..'), false);
  }
  assert.equal(JSON.stringify(body).includes(env.dataDir), false);
});

test('deleting a title removes managed copies while preserving its original source', async (t) => {
  const env = await fixture(t);
  const original = join(env.root, 'original.mp4');
  await writeFile(original, video);
  const baseline = await regularFiles(env.app.mediaPath);
  const item = await upload(env, 'original.mp4', await readFile(original));
  const posterResult = await json(env, `/api/titles/${item.id}/poster`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png,
  });
  assert.equal(posterResult.response.status, 200);
  assert.notDeepEqual(await regularFiles(env.app.mediaPath), baseline);
  const deleted = await json(env, `/api/titles/${item.id}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.ok, true);
  assert.deepEqual((await json(env, '/api/titles')).body, []);
  assert.deepEqual(await regularFiles(env.app.mediaPath), baseline);
  assert.deepEqual(await readFile(original), video);
  for (const suffix of ['stream', 'poster']) {
    const response = await fetch(`${env.url}/api/titles/${item.id}/${suffix}`);
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  }
  await env.stop();
  await env.start();
  assert.deepEqual((await json(env, '/api/titles')).body, []);
});

test('foreign origins and untrusted hostnames cannot mutate the local library', async (t) => {
  const env = await fixture(t);
  const rejected = await json(env, '/api/uploads', {
    method: 'POST',
    headers: {
      Origin: 'https://untrusted.example', 'Content-Type': 'video/mp4',
      'X-File-Name': encodeURIComponent('forbidden.mp4'),
    },
    body: video,
  });
  assert.equal(rejected.response.status, 403);
  assert.equal(rejected.response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual((await json(env, '/api/titles')).body, []);
  const item = await upload(env);
  const edited = await patch(env, item.id, { title: 'Must stay unchanged' }, { Origin: 'https://untrusted.example' });
  assert.equal(edited.response.status, 403);
  assert.equal((await json(env, '/api/titles')).body[0].title, item.title);
  const badHost = await rawRequest(env, '/api/titles', { Host: 'untrusted.example' });
  assert.equal(badHost.status, 403);
  const allowed = await patch(env, item.id, { watchlist: true }, { Origin: env.url });
  assert.equal(allowed.response.status, 200);
});

test('encoded paths and unknown media IDs cannot expose arbitrary files', async (t) => {
  const env = await fixture(t);
  for (const path of [
    '/%2e%2e/private.txt', '/%2e%2e%5cprivate.txt', '/%2e%2e%2fprivate.txt',
    '/api/titles/%2e%2e%2fprivate.txt/stream', '/api/titles/does-not-exist/stream',
    `/api/titles/${encodeURIComponent(join(env.root, 'private.txt'))}/stream`,
    '/library/library.sqlite', '/api/settings/../../../private.txt',
  ]) {
    const result = await rawRequest(env, path);
    assert.ok([400, 403, 404].includes(result.status), `${path}: ${result.status}`);
    assert.equal(result.body.includes(Buffer.from('OUTSIDE_THE_WEB_AND_MEDIA_ROOTS')), false);
  }
});

test('an interrupted upload is cleaned up without publishing an incomplete title', async (t) => {
  const env = await fixture(t);
  const baseline = await regularFiles(env.dataDir);
  let req;
  const requestClosed = new Promise((done) => {
    req = request(`${env.url}/api/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'video/mp4', 'X-File-Name': encodeURIComponent('interrupted.mp4'),
        'Content-Length': video.length + 1024 * 1024,
      },
    });
    req.on('error', () => {});
    req.on('close', done);
    req.write(video);
  });
  try {
    await eventually(async () => {
      assert.notDeepEqual(await regularFiles(env.dataDir), baseline);
    }, 'the server did not begin receiving the test upload');
  } finally {
    req.destroy();
    await requestClosed;
  }
  await eventually(async () => {
    assert.deepEqual(await regularFiles(env.dataDir), baseline);
  }, 'an aborted upload left temporary files behind');
  assert.deepEqual((await json(env, '/api/titles')).body, []);
  const later = await upload(env, 'complete-after-abort.mp4');
  assert.equal(later.available, true);
});
