import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApp } from '../apps/server/app.mjs';
import { MAX_CATALOG_BYTES, MAX_CATALOG_ROWS, parseCatalogCsv } from '../apps/server/metadata/catalog.mjs';

const testsRoot = dirname(fileURLToPath(import.meta.url));
// Transport fixture only: no personal media or outside network is used.
const video = Buffer.from('000000186674797069736f6d0000020069736f6d69736f326d646174', 'hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=', 'base64');
const png2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

async function fixture(t) {
  const root = await mkdtemp(join(testsRoot, '.runtime-catalog-'));
  const dataDir = join(root, 'library');
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Offline catalog test</title>');
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
    if (env.app) { await env.app.close(); env.app = null; }
  };
  t.after(async () => {
    await env.stop();
    const target = resolve(root);
    assert.ok(target.startsWith(`${resolve(testsRoot)}${sep}.runtime-catalog-`));
    await rm(target, { recursive: true, force: true });
  });
  await env.start();
  return env;
}

async function json(env, route, options) {
  const response = await fetch(`${env.url}${route}`, options);
  return { response, body: await response.json() };
}

function post(input, headers = {}) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) };
}

function importCsv(env, text, headers = {}) {
  return json(env, '/api/catalog/import', {
    method: 'POST', headers: { 'Content-Type': 'text/csv; charset=utf-8', ...headers }, body: text,
  });
}

function search(env, query, year) {
  return json(env, '/api/catalog/search', post({ query, ...(year === undefined ? {} : { year }) }));
}

function uploadPoster(env, filename, bytes = png, mime = 'image/png', headers = {}) {
  return json(env, '/api/catalog/posters', {
    method: 'POST', headers: { 'Content-Type': mime, 'X-File-Name': encodeURIComponent(filename), ...headers }, body: bytes,
  });
}

async function uploadVideo(env, filename = 'A1_T00.mp4') {
  const result = await json(env, '/api/uploads', {
    method: 'POST', headers: { 'Content-Type': 'video/mp4', 'X-File-Name': encodeURIComponent(filename) }, body: video,
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body;
}

function patch(env, id, input) {
  return json(env, `/api/titles/${id}`, { ...post(input), method: 'PATCH' });
}

async function bytes(env, route) {
  const response = await fetch(`${env.url}${route}`);
  assert.equal(response.status, 200, route);
  return Buffer.from(await response.arrayBuffer());
}

async function files(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => entry.isDirectory()
    ? (await files(join(root, entry.name))).map((name) => join(entry.name, name)) : [entry.name]));
  return nested.flat().sort();
}

test('CSV parsing handles a UTF-8 BOM, quoted commas, quoted newlines, and escaped quotes', () => {
  const [item] = parseCatalogCsv('\uFEFFid,title,year,description,poster_filename,genre\r\n' +
    'night,"A Night, Somewhere",2021,"Line one\r\nA ""quoted"" second line",Cover.PNG,"Drama, Mystery"\r\n');
  assert.equal(item.id, 'night');
  assert.equal(item.title, 'A Night, Somewhere');
  assert.equal(item.year, 2021);
  assert.equal(item.description, 'Line one\r\nA "quoted" second line');
  assert.equal(item.posterFilename, 'Cover.PNG');
  assert.equal(item.genre, 'Drama, Mystery');
  const first = parseCatalogCsv('title,year\nCafé Night,2021\n')[0];
  const again = parseCatalogCsv('title,year\nCafé Night,2021\n')[0];
  const remake = parseCatalogCsv('title,year\nCafé Night,2022\n')[0];
  assert.equal(first.id, again.id, 'imports without an id produce a stable identity');
  assert.notEqual(first.id, remake.id, 'different release years can identify remakes');
  assert.equal(parseCatalogCsv('title,year\nUnknown,\\N\n')[0].year, null);
});

test('malformed CSV, duplicate identities, invalid years, and unsafe poster references are rejected', () => {
  const invalid = [
    'name\nMovie\n', 'title,title\nMovie,Movie\n', 'title\n',
    'title,year\nMovie\n', 'title\n"Unclosed\n', 'title\n"Closed"oops\n',
    'title\nUnescaped"quote\n', 'id,title\nsame,One\nsame,Two\n',
    'title,year\nMovie,1870\n', 'title,year\nMovie,2021.5\n',
    'title,year\nMovie,not-a-year\n', 'title,year\nMovie,9999\n',
    'id,title\n../../outside,Movie\n', 'title\nBad\u0000title\n',
    'title,poster_filename\nMovie,https://example.com/cover.jpg\n',
    'title,poster_filename\nMovie,../cover.jpg\n',
    'title,poster_filename\nMovie,C:\\private\\cover.jpg\n',
    'title,poster_filename\nMovie,cover.svg\n',
  ];
  for (const text of invalid) assert.throws(() => parseCatalogCsv(text), { status: 400 }, text);
  const limit = 'x'.repeat(10000);
  assert.equal(parseCatalogCsv(`title,description\nMovie,${limit}\n`)[0].description, limit);
  assert.throws(() => parseCatalogCsv(`title,description\nMovie,${limit}x\n`), { status: 400 });
});

test('catalog size boundaries accept 50,000 rows and reject oversized input', () => {
  const csv = `id,title\n${Array.from({ length: MAX_CATALOG_ROWS }, (_, index) => `m${index},Movie ${index}`).join('\n')}\n`;
  assert.equal(parseCatalogCsv(csv).length, MAX_CATALOG_ROWS);
  assert.throws(() => parseCatalogCsv(`${csv}too_many,Another movie\n`), { status: 400 });
  assert.throws(() => parseCatalogCsv('x'.repeat(MAX_CATALOG_BYTES + 1)), { status: 413 });
});

test('CSV imports remain separate from playable videos and persist across restart', async (t) => {
  const env = await fixture(t);
  const initial = (await json(env, '/api/catalog')).body;
  assert.equal(initial.totalTitles, 0);
  assert.equal(initial.localOnly, true);
  const imported = await importCsv(env, 'id,title,year,description,poster_filename,genre\n' +
    'one,Café Night,2021,A late walk,night.png,Drama\n' +
    'two,Café Night,1990,An earlier version,,Comedy\n');
  assert.equal(imported.response.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.imported, 2);
  assert.equal(imported.body.inserted, 2);
  assert.equal(imported.body.updated, 0);
  assert.equal(imported.body.totalTitles, 2);
  assert.equal(imported.body.posterReferences, 1);
  assert.equal(imported.body.posterCount, 0);
  assert.equal(imported.body.missingPosters, 1);
  assert.deepEqual(imported.body.posterFilenames, ['night.png']);
  assert.deepEqual((await json(env, '/api/titles')).body, [], 'catalog entries are never fake playable movies');
  await env.stop();
  await env.start();
  assert.equal((await json(env, '/api/catalog')).body.totalTitles, 2);
  const found = await search(env, 'CAFE night', 2021);
  assert.equal(found.response.status, 200);
  assert.deepEqual(found.body.map((item) => item.id), ['one']);
  assert.equal(found.body[0].genre, 'Drama');
  assert.equal(found.body[0].poster, null);
  assert.equal((await search(env, 'a completely missing title')).body.length, 0);
  assert.deepEqual((await json(env, '/api/titles')).body, []);
});

test('reimports update stable IDs and malformed files leave the whole catalog unchanged', async (t) => {
  const env = await fixture(t);
  await importCsv(env, 'id,title,year\nfirst,Original title,2001\n');
  const changed = await importCsv(env, 'id,title,year\nfirst,Corrected title,2002\nsecond,Another title,2003\n');
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.inserted, 1);
  assert.equal(changed.body.updated, 1);
  const merged = await importCsv(env, 'id,title,year\nfirst,Corrected title,2002\n');
  assert.equal(merged.body.totalTitles, 2, 'omitting an existing row from a reimport does not delete it');
  const before = (await search(env, 'title')).body;
  const rejected = await importCsv(env, 'id,title,year\nfirst,Must not partially publish,2004\nthird,Invalid year,nope\n');
  assert.equal(rejected.response.status, 400);
  assert.deepEqual((await search(env, 'title')).body, before);
  assert.equal((await search(env, 'Must not partially publish')).body.length, 0);
  assert.equal((await json(env, '/api/catalog')).body.totalTitles, 2);
});

test('the persistent catalog cap rejects extra rows atomically but still allows corrections at capacity', async (t) => {
  const env = await fixture(t);
  const csv = `id,title\n${Array.from({ length: MAX_CATALOG_ROWS }, (_, index) => `m${index},Movie ${index}`).join('\n')}\n`;
  const full = await importCsv(env, csv);
  assert.equal(full.response.status, 200, JSON.stringify(full.body));
  assert.equal(full.body.totalTitles, MAX_CATALOG_ROWS);
  const overflow = await importCsv(env, 'id,title\nm0,Must not be changed\nextra,Extra movie\n');
  assert.equal(overflow.response.status, 400);
  assert.equal((await search(env, 'Must not be changed')).body.length, 0);
  assert.equal((await search(env, 'Extra movie')).body.length, 0);
  assert.equal((await json(env, '/api/catalog')).body.totalTitles, MAX_CATALOG_ROWS);
  const corrected = await importCsv(env, 'id,title\nm0,A corrected title\n');
  assert.equal(corrected.response.status, 200);
  assert.equal(corrected.body.updated, 1);
  assert.equal(corrected.body.inserted, 0);
  assert.equal((await search(env, 'A corrected title')).body[0].id, 'm0');
});

test('catalog HTTP endpoints reject foreign origins, invalid requests, and non-UTF-8 CSV', async (t) => {
  const env = await fixture(t);
  assert.equal((await importCsv(env, 'title\nMovie\n', { Origin: 'https://elsewhere.example' })).response.status, 403);
  assert.equal((await importCsv(env, 'title\nMovie\n', { 'Sec-Fetch-Site': 'cross-site' })).response.status, 403);
  assert.equal((await importCsv(env, 'title\nMovie\n', { 'Content-Type': 'application/json' })).response.status, 415);
  assert.equal((await importCsv(env, Buffer.from([0xff, 0xfe, 0x61]))).response.status, 400);
  assert.equal((await importCsv(env, 'x'.repeat(MAX_CATALOG_BYTES + 1))).response.status, 413);
  for (const input of [{ query: '' }, { query: '%' }, { query: 'Movie', year: '2021' },
    { query: 'Movie', url: 'https://example.com' }, { query: 'Movie', year: 1800 }]) {
    assert.equal((await json(env, '/api/catalog/search', post(input))).response.status, 400);
  }
  assert.equal((await json(env, '/api/catalog')).body.totalTitles, 0);
});

test('local posters link by case-insensitive basename and support exact GET and HEAD after restart', async (t) => {
  const env = await fixture(t);
  await importCsv(env, 'id,title,poster_filename\nfirst,Poster Test,Cover.PNG\nsecond,Same Cover,cover.png\n');
  const result = await uploadPoster(env, 'cover.png');
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.posterCount, 1);
  assert.equal(result.body.posterReferences, 1);
  assert.equal(result.body.missingPosters, 0);
  const found = (await search(env, 'Poster Test')).body[0];
  assert.equal(found.poster, '/api/catalog/items/first/poster');
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(`${env.url}${found.poster}`, { method });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(Number(response.headers.get('content-length')), png.length);
    const body = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(body, method === 'HEAD' ? Buffer.alloc(0) : png);
  }
  await env.stop();
  await env.start();
  assert.deepEqual(await bytes(env, found.poster), png);
  assert.deepEqual(await bytes(env, '/api/catalog/items/second/poster'), png);
  assert.equal((await json(env, '/api/catalog')).body.posterCount, 1);
});

test('unknown or unsafe posters and invalid image contents publish no managed files', async (t) => {
  const env = await fixture(t);
  await importCsv(env, 'id,title,poster_filename\nfirst,Poster Test,cover.png\n');
  const before = await files(join(env.dataDir, 'media'));
  for (const [filename, expected] of [['unreferenced.png', 404], ['../cover.png', 400], ['C:\\cover.png', 400]]) {
    assert.equal((await uploadPoster(env, filename)).response.status, expected);
  }
  assert.equal((await uploadPoster(env, 'cover.png', Buffer.from('<svg><script>alert(1)</script></svg>'))).response.status, 415);
  assert.equal((await uploadPoster(env, 'cover.png', png, 'image/svg+xml')).response.status, 415);
  assert.equal((await uploadPoster(env, 'cover.png', png, 'image/jpeg')).response.status, 415);
  assert.equal((await uploadPoster(env, 'cover.png', png, 'image/png', { Origin: 'https://other.example' })).response.status, 403);
  assert.deepEqual(await files(join(env.dataDir, 'media')), before);
  assert.deepEqual(await files(join(env.dataDir, 'tmp')), []);
  assert.equal((await json(env, '/api/catalog')).body.posterCount, 0);
  assert.equal((await json(env, '/api/catalog/items/first/poster')).response.status, 404);
});

test('a status-read failure after poster commit does not delete the newly saved image', async (t) => {
  const env = await fixture(t);
  await importCsv(env, 'id,title,poster_filename\nposter,Poster Commit Test,cover.png\n');
  assert.equal((await uploadPoster(env, 'cover.png')).response.status, 200);
  const originalStatus = env.app.catalog.status;
  env.app.catalog.status = () => { throw new Error('Injected catalog status read failure after image commit'); };
  try {
    const replacement = await uploadPoster(env, 'cover.png', png2);
    assert.equal(replacement.response.status, 500);
  } finally {
    env.app.catalog.status = originalStatus;
  }
  assert.deepEqual(await bytes(env, '/api/catalog/items/poster/poster'), png2);
  assert.equal((await json(env, '/api/catalog')).body.posterCount, 1);
  assert.deepEqual(await files(join(env.dataDir, 'tmp')), []);
  assert.equal((await files(join(env.dataDir, 'media', 'posters'))).length, 1, 'only the replacement poster remains');
  await env.stop();
  await env.start();
  assert.deepEqual(await bytes(env, '/api/catalog/items/poster/poster'), png2);
});

test('matching a catalog movie preserves playback, media, category, and My List while copying its cover', async (t) => {
  const env = await fixture(t);
  const movie = await uploadVideo(env);
  const saved = { category: 'home', watchlist: true, duration: 600, position: 125.5, completed: false };
  assert.equal((await patch(env, movie.id, saved)).response.status, 200);
  const description = 'A long movie description. '.repeat(120);
  assert.ok(description.length > 2000 && description.length < 10000);
  await importCsv(env, `id,title,year,description,poster_filename,genre\nnight,The Correct Movie,2001,${description},cover.png,Drama\n`);
  await uploadPoster(env, 'cover.png');
  const applied = await json(env, `/api/titles/${movie.id}/catalog`, post({ catalogId: 'night' }));
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.id, movie.id);
  assert.equal(applied.body.title, 'The Correct Movie');
  assert.equal(applied.body.year, 2001);
  assert.equal(applied.body.description, description.trim());
  for (const [key, value] of Object.entries(saved)) assert.equal(applied.body[key], value, key);
  for (const key of ['originalName', 'fileSize', 'mimeType', 'available', 'createdAt']) assert.equal(applied.body[key], movie[key], key);
  assert.deepEqual(await bytes(env, `/api/titles/${movie.id}/stream`), video);
  assert.deepEqual(await bytes(env, applied.body.poster), png);
  // A catalog refresh must not silently replace a cover already applied to a movie.
  await uploadPoster(env, 'cover.png', png2);
  assert.deepEqual(await bytes(env, '/api/catalog/items/night/poster'), png2);
  assert.deepEqual(await bytes(env, applied.body.poster), png);
  assert.equal((await patch(env, movie.id, { title: 'My own title', description: 'My own notes' })).response.status, 200);
  await env.stop();
  await env.start();
  const reopened = (await json(env, `/api/titles/${movie.id}`)).body;
  assert.equal(reopened.title, 'My own title');
  assert.equal(reopened.description, 'My own notes');
  assert.equal(reopened.position, saved.position);
  assert.deepEqual(await bytes(env, reopened.poster), png);
  assert.equal((await json(env, `/api/titles/${movie.id}`, { method: 'DELETE' })).response.status, 200);
  assert.deepEqual(await bytes(env, '/api/catalog/items/night/poster'), png2, 'removing one movie cannot remove reusable catalog artwork');
});

test('matching without catalog artwork preserves an existing cover, and invalid matches change nothing', async (t) => {
  const env = await fixture(t);
  const movie = await uploadVideo(env);
  const cover = await json(env, `/api/titles/${movie.id}/poster`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(cover.response.status, 200);
  await importCsv(env, 'id,title,year,poster_filename\nnoart,Movie Without New Cover,2020,missing.png\n');
  const applied = await json(env, `/api/titles/${movie.id}/catalog`, post({ catalogId: 'noart' }));
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.title, 'Movie Without New Cover');
  assert.deepEqual(await bytes(env, applied.body.poster), png);
  for (const [input, expected] of [[{ catalogId: 'unknown' }, 404], [{ catalogId: '../outside' }, 400],
    [{ catalogId: 'noart', title: 'Injected title' }, 400], [{}, 400]]) {
    const response = await json(env, `/api/titles/${movie.id}/catalog`, post(input));
    assert.equal(response.response.status, expected);
    assert.deepEqual((await json(env, `/api/titles/${movie.id}`)).body, applied.body);
  }
  const blocked = await json(env, `/api/titles/${movie.id}/catalog`, post({ catalogId: 'noart' }, { Origin: 'https://other.example' }));
  assert.equal(blocked.response.status, 403);
});

test('matching a names-only catalog entry preserves an existing year, description, and cover', async (t) => {
  const env = await fixture(t);
  const movie = await uploadVideo(env);
  const saved = { year: 2008, description: 'Notes I entered myself', watchlist: true, position: 42, duration: 400 };
  assert.equal((await patch(env, movie.id, saved)).response.status, 200);
  const cover = await json(env, `/api/titles/${movie.id}/poster`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png,
  });
  assert.equal(cover.response.status, 200);
  const imported = await importCsv(env, 'id,title\njustname,A Better Movie Name\n');
  assert.equal(imported.response.status, 200);
  const applied = await json(env, `/api/titles/${movie.id}/catalog`, post({ catalogId: 'justname' }));
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.title, 'A Better Movie Name');
  for (const [key, value] of Object.entries(saved)) assert.equal(applied.body[key], value, key);
  assert.deepEqual(await bytes(env, applied.body.poster), png);
  await env.stop();
  await env.start();
  const reopened = (await json(env, `/api/titles/${movie.id}`)).body;
  assert.equal(reopened.title, applied.body.title);
  for (const [key, value] of Object.entries(saved)) assert.equal(reopened[key], value, key);
  assert.deepEqual(await bytes(env, reopened.poster), png);
});

test('a missing catalog cover aborts applying metadata and preserves the existing movie and cover', async (t) => {
  const env = await fixture(t);
  const movie = await uploadVideo(env);
  await patch(env, movie.id, { title: 'My original title', year: 2020, description: 'Original notes', position: 77, duration: 300 });
  await json(env, `/api/titles/${movie.id}/poster`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png2 });
  const before = (await json(env, `/api/titles/${movie.id}`)).body;
  await importCsv(env, 'id,title,year,description,poster_filename\nmissing,Replacement metadata,2021,Replacement notes,cover.png\n');
  await uploadPoster(env, 'cover.png');
  await env.app.source.removeKey(env.app.catalog.getPosterKey('missing'));
  const applied = await json(env, `/api/titles/${movie.id}/catalog`, post({ catalogId: 'missing' }));
  assert.equal(applied.response.status, 404);
  assert.deepEqual((await json(env, `/api/titles/${movie.id}`)).body, before);
  assert.deepEqual(await bytes(env, before.poster), png2);
  assert.deepEqual(await bytes(env, `/api/titles/${movie.id}/stream`), video);
  assert.deepEqual(await files(join(env.dataDir, 'tmp')), []);
});
