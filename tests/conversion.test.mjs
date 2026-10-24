import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createApp } from '../apps/server/app.mjs';

const testsRoot = dirname(fileURLToPath(import.meta.url));
const flowerPath = join(testsRoot, 'fixtures', 'flower.mp4');
const execute = promisify(execFile);
const require = createRequire(import.meta.url);
// Deliberately not decodable: injected engines test lifecycle and storage. The
// real FFmpeg test below creates, converts, and fully decodes an actual MKV.
const sourceBytes = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.from('Original MKV bytes that must never be overwritten.'),
]);

async function fixture(t, conversion) {
  const root = await mkdtemp(join(testsRoot, '.runtime-conversion-'));
  const dataDir = join(root, 'library');
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Conversion tests</title>');
  const env = { root, dataDir, webDir, app: null, url: '' };
  env.start = async (options = conversion) => {
    env.app = await createApp({ dataDir, webDir, conversion: options });
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
    assert.ok(cleanupTarget.startsWith(`${resolve(testsRoot)}${sep}.runtime-conversion-`));
    await rm(cleanupTarget, { recursive: true, force: true });
  });
  await env.start();
  return env;
}

async function json(env, route, options) {
  const response = await fetch(`${env.url}${route}`, options);
  return { response, body: await response.json() };
}

function post(body = {}, headers = {}) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

async function upload(env, name = 'Original movie.mkv', bytes = sourceBytes) {
  const result = await json(env, '/api/uploads', {
    method: 'POST', headers: { 'Content-Type': 'video/x-matroska', 'X-File-Name': encodeURIComponent(name) }, body: bytes,
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function bytesFor(env, id) {
  const response = await fetch(`${env.url}/api/titles/${id}/stream`);
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}

async function eventually(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try { return await check(); } catch (error) { lastError = error; }
    await new Promise((done) => setTimeout(done, 25));
  } while (Date.now() < deadline);
  throw new Error(description, { cause: lastError });
}

async function getJob(env, id) {
  const result = await json(env, '/api/conversion/jobs');
  assert.equal(result.response.status, 200);
  assert.ok(Array.isArray(result.body));
  const job = result.body.find((entry) => entry.id === id);
  assert.ok(job, 'created job must remain in conversion history');
  return job;
}

async function waitForStatus(env, id, status, timeout) {
  return eventually(async () => {
    const job = await getJob(env, id);
    assert.equal(job.status, status, JSON.stringify(job));
    return job;
  }, `conversion did not become ${status}`, timeout);
}

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const file of await filesUnder(join(root, entry.name))) files.push(join(entry.name, file));
    } else if (entry.isFile()) files.push(entry.name);
  }
  return files.sort();
}

function controlledEngine() {
  let finish;
  const gate = new Promise((done) => { finish = done; });
  const control = { calls: [], finish };
  control.engine = {
    available: true,
    async run(context) {
      control.calls.push(context);
      await copyFile(flowerPath, context.outputPath);
      context.onProgress(0.35);
      if (context.signal.aborted) throw Object.assign(new Error('Canceled'), { name: 'AbortError' });
      let abort;
      try {
        await Promise.race([gate, new Promise((_, reject) => {
          abort = () => reject(Object.assign(new Error('Canceled'), { name: 'AbortError' }));
          context.signal.addEventListener('abort', abort, { once: true });
        })]);
      } finally { context.signal.removeEventListener('abort', abort); }
      if (context.signal.aborted) throw Object.assign(new Error('Canceled'), { name: 'AbortError' });
      context.onProgress(1);
    },
  };
  return control;
}

test('conversion availability is explicit and an unavailable engine cannot create jobs', async (t) => {
  const env = await fixture(t, { engine: { available: false, reason: 'Test converter is unavailable.' } });
  const capability = await json(env, '/api/conversion');
  assert.equal(capability.response.status, 200);
  assert.equal(capability.body.available, false);
  assert.equal(typeof capability.body.reason, 'string');
  const title = await upload(env);
  const requested = await json(env, `/api/titles/${title.id}/conversions`, post());
  assert.equal(requested.response.status, 503);
  assert.deepEqual((await json(env, '/api/conversion/jobs')).body, []);
  assert.deepEqual(await bytesFor(env, title.id), sourceBytes);
});

test('conversion publishes a separate MP4, preserves original bytes, and persists completed history', async (t) => {
  const control = controlledEngine();
  const env = await fixture(t, { engine: control.engine });
  assert.equal((await json(env, '/api/conversion')).body.available, true);
  const originalPath = join(env.root, 'Owner original.mkv');
  await writeFile(originalPath, sourceBytes);
  const original = await upload(env, 'Owner original.mkv', await readFile(originalPath));
  const updated = await json(env, `/api/titles/${original.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Family night', category: 'home', year: 2020, description: 'An owner supplied movie.' }),
  });
  assert.equal(updated.response.status, 200);
  const requested = await json(env, `/api/titles/${original.id}/conversions`, post());
  assert.equal(requested.response.status, 202, JSON.stringify(requested.body));
  assert.equal(requested.body.sourceTitleId, original.id);
  assert.equal(requested.body.sourceTitle, 'Family night');
  assert.equal(requested.body.status, 'running');
  await eventually(async () => {
    const running = await getJob(env, requested.body.id);
    assert.equal(running.progress, 35);
  }, 'engine progress was not exposed through the API');
  assert.equal(control.calls.length, 1);
  assert.deepEqual(await readFile(control.calls[0].inputPath), sourceBytes);
  control.finish();
  const finished = await waitForStatus(env, requested.body.id, 'completed');
  assert.equal(finished.progress, 100);
  assert.ok(finished.outputTitleId);
  assert.notEqual(finished.outputTitleId, original.id);
  const titles = (await json(env, '/api/titles')).body;
  assert.equal(titles.length, 2);
  const output = titles.find((entry) => entry.id === finished.outputTitleId);
  assert.ok(output);
  assert.equal(output.mimeType, 'video/mp4');
  assert.match(output.originalName, /\.mp4$/i);
  assert.equal(output.available, true);
  assert.equal(output.category, 'home');
  assert.equal(output.year, 2020);
  assert.equal(output.description, 'An owner supplied movie.');
  assert.deepEqual(await bytesFor(env, original.id), sourceBytes);
  assert.deepEqual(await readFile(originalPath), sourceBytes);
  assert.deepEqual(await bytesFor(env, output.id), await readFile(flowerPath));
  assert.deepEqual(await filesUnder(join(env.dataDir, 'tmp')), []);
  await env.stop();
  await env.start();
  assert.equal((await getJob(env, finished.id)).status, 'completed');
  assert.deepEqual(await bytesFor(env, output.id), await readFile(flowerPath));
  assert.deepEqual(await bytesFor(env, original.id), sourceBytes);
});

test('only one conversion runs at a time and canceling removes partial output without deleting either source', async (t) => {
  const control = controlledEngine();
  const env = await fixture(t, { engine: control.engine });
  const first = await upload(env);
  const second = await upload(env, 'Another movie.mkv');
  const mediaBefore = await filesUnder(env.app.mediaPath);
  const requested = await json(env, `/api/titles/${first.id}/conversions`, post());
  assert.equal(requested.response.status, 202);
  await eventually(async () => assert.equal(control.calls.length, 1), 'test engine did not start');
  for (const id of [first.id, second.id]) {
    const busy = await json(env, `/api/titles/${id}/conversions`, post());
    assert.equal(busy.response.status, 409);
  }
  const deletion = await json(env, `/api/titles/${first.id}`, { method: 'DELETE' });
  assert.equal(deletion.response.status, 409);
  const canceled = await json(env, `/api/conversion/jobs/${requested.body.id}/cancel`, post());
  assert.equal(canceled.response.status, 200);
  const final = await waitForStatus(env, requested.body.id, 'canceled');
  assert.ok(!final.outputTitleId);
  assert.equal(control.calls[0].signal.aborted, true);
  await eventually(async () => assert.deepEqual(await filesUnder(join(env.dataDir, 'tmp')), []), 'partial conversion output was not removed');
  assert.deepEqual(await filesUnder(env.app.mediaPath), mediaBefore);
  assert.equal((await json(env, '/api/titles')).body.length, 2);
  assert.deepEqual(await bytesFor(env, first.id), sourceBytes);
  assert.deepEqual(await bytesFor(env, second.id), sourceBytes);
  // Cancellation releases the source lock and leaves ordinary removal usable.
  assert.equal((await json(env, `/api/titles/${first.id}`, { method: 'DELETE' })).response.status, 200);
});

test('an engine failure removes partial output and keeps a useful failed job without publishing a title', async (t) => {
  const engine = { available: true, async run({ outputPath, onProgress }) {
    await writeFile(outputPath, 'incomplete output');
    onProgress(0.2);
    throw new Error('Test encoder failed while reading the input.');
  } };
  const env = await fixture(t, { engine });
  const title = await upload(env);
  const mediaBefore = await filesUnder(env.app.mediaPath);
  const requested = await json(env, `/api/titles/${title.id}/conversions`, post());
  assert.equal(requested.response.status, 202);
  const failed = await waitForStatus(env, requested.body.id, 'failed');
  assert.ok(failed.error, 'failed jobs need an error for the user');
  assert.ok(!failed.outputTitleId);
  assert.equal((await json(env, '/api/titles')).body.length, 1);
  assert.deepEqual(await filesUnder(env.app.mediaPath), mediaBefore);
  assert.deepEqual(await filesUnder(join(env.dataDir, 'tmp')), []);
  assert.deepEqual(await bytesFor(env, title.id), sourceBytes);
  await env.stop();
  await env.start();
  assert.equal((await getJob(env, failed.id)).status, 'failed');
});

test('conversion endpoints reject unknown IDs, foreign origins, and caller selected paths or commands', async (t) => {
  let runs = 0;
  const env = await fixture(t, { engine: { available: true, async run() { runs++; } } });
  const title = await upload(env);
  assert.equal((await json(env, '/api/titles/does-not-exist/conversions', post())).response.status, 404);
  assert.equal((await json(env, '/api/conversion/jobs/does-not-exist/cancel', post())).response.status, 404);
  for (const fields of [
    { inputPath: join(env.root, 'private.mkv') },
    { outputPath: join(env.root, 'overwrite.mp4') },
    { ffmpegPath: 'another-program.exe' },
    { args: ['-i', 'outside.mkv'] },
    { command: 'run an arbitrary program' },
  ]) {
    const rejected = await json(env, `/api/titles/${title.id}/conversions`, post(fields));
    assert.equal(rejected.response.status, 400, JSON.stringify(fields));
  }
  assert.equal((await json(env, `/api/titles/${title.id}/conversions`, post({}, { Origin: 'https://untrusted.example' }))).response.status, 403);
  assert.equal((await json(env, '/api/conversion/jobs/does-not-exist/cancel', post({}, { Origin: 'https://untrusted.example' }))).response.status, 403);
  assert.equal(runs, 0);
  assert.deepEqual((await json(env, '/api/conversion/jobs')).body, []);
  assert.deepEqual(await bytesFor(env, title.id), sourceBytes);
});

test('a converter claiming success cannot publish an invalid MP4 container', async (t) => {
  const env = await fixture(t, { engine: { available: true, async run({ outputPath }) {
    await writeFile(outputPath, 'An encoder result without any MP4 header.');
  } } });
  const title = await upload(env);
  const mediaBefore = await filesUnder(env.app.mediaPath);
  const requested = await json(env, `/api/titles/${title.id}/conversions`, post());
  assert.equal(requested.response.status, 202);
  const failed = await waitForStatus(env, requested.body.id, 'failed');
  assert.ok(failed.error);
  assert.ok(!failed.outputTitleId);
  assert.deepEqual(await filesUnder(env.app.mediaPath), mediaBefore);
  assert.deepEqual(await filesUnder(join(env.dataDir, 'tmp')), []);
  assert.equal((await json(env, '/api/titles')).body.length, 1);
  assert.deepEqual(await bytesFor(env, title.id), sourceBytes);
});

test('startup marks a crash-interrupted job honestly and removes its unpublished partial file', async (t) => {
  const control = controlledEngine();
  const env = await fixture(t, { engine: control.engine });
  const title = await upload(env);
  const mediaBefore = await filesUnder(env.app.mediaPath);
  const requested = await json(env, `/api/titles/${title.id}/conversions`, post());
  assert.equal(requested.response.status, 202);
  await eventually(async () => {
    assert.equal(control.calls.length, 1);
    assert.equal((await getJob(env, requested.body.id)).progress, 35);
  }, 'test conversion did not begin');
  await env.stop();
  // A normal close cancels its subprocess. Recreate the persisted state left by
  // an abrupt process exit to exercise recovery, without killing the test runner.
  const historyPath = join(env.dataDir, 'conversion-jobs.json');
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  const saved = history.find((entry) => entry.id === requested.body.id);
  assert.ok(saved);
  saved.status = 'running';
  saved.progress = 35;
  await writeFile(historyPath, JSON.stringify(history));
  await writeFile(join(env.dataDir, 'tmp', `conversion-${saved.id}.mp4.part`), 'partial file left by an interrupted encoder');
  await env.start();
  const interrupted = await getJob(env, requested.body.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.ok(!interrupted.outputTitleId);
  assert.deepEqual(await filesUnder(env.app.mediaPath), mediaBefore);
  assert.deepEqual(await filesUnder(join(env.dataDir, 'tmp')), []);
  assert.equal((await json(env, '/api/titles')).body.length, 1);
  assert.deepEqual(await bytesFor(env, title.id), sourceBytes);
});

test('real FFmpeg converts an encoded MKV to a fully decodable H.264 MP4 through the API', { timeout: 90000 }, async (t) => {
  // This is a required integration test, not an optional silent skip. npm ci
  // must install the bundled binary used by the app and its Windows package.
  const ffmpegPath = require('ffmpeg-static');
  assert.equal(typeof ffmpegPath, 'string', 'ffmpeg-static must provide a local converter binary');
  const env = await fixture(t, { ffmpegPath });
  const mkvPath = join(env.root, 'real-source.mkv');
  await execute(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', flowerPath, '-map', '0', '-c', 'copy', '-y', mkvPath], { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 ** 2 });
  const mkv = await readFile(mkvPath);
  assert.ok(mkv.length > 10000);
  assert.deepEqual(mkv.subarray(0, 4), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const source = await upload(env, 'Real encoded movie.mkv', mkv);
  const capability = await json(env, '/api/conversion');
  assert.equal(capability.body.available, true, JSON.stringify(capability.body));
  const requested = await json(env, `/api/titles/${source.id}/conversions`, post());
  assert.equal(requested.response.status, 202, JSON.stringify(requested.body));
  const converted = await waitForStatus(env, requested.body.id, 'completed', 60000);
  const mp4 = await bytesFor(env, converted.outputTitleId);
  assert.equal(mp4.toString('ascii', 4, 8), 'ftyp');
  const outputPath = join(env.root, 'verified-output.mp4');
  await writeFile(outputPath, mp4);
  const decoded = await execute(ffmpegPath, ['-hide_banner', '-nostdin', '-xerror', '-i', outputPath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 ** 2 });
  assert.match(decoded.stderr, /Video: h264/);
  assert.match(decoded.stderr, /Audio: aac/);
  assert.match(decoded.stderr, /yuv420p/);
  assert.match(decoded.stderr, /960x540/);
  assert.match(decoded.stderr, /frame=\s*150\b/);
  assert.deepEqual(await bytesFor(env, source.id), mkv);
  assert.deepEqual(await readFile(mkvPath), mkv);
  const output = (await json(env, '/api/titles')).body.find((entry) => entry.id === converted.outputTitleId);
  assert.equal(output.mimeType, 'video/mp4');
  assert.equal(output.available, true);
  assert.equal(output.fileSize, mp4.length);
});
