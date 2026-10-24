import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../dist/api.js', import.meta.url), 'utf8');

// Compile functions directly from the shipped app. V8 finds the complete
// declaration, so these checks do not contain a second workflow implementation.
function actualFunction(name) {
  const start = appSource.search(new RegExp(`^(?:async )?function ${name}\\s*\\(`, 'm'));
  assert.notEqual(start, -1, `app function ${name} is present`);
  for (let end = appSource.indexOf('}', start); end !== -1; end = appSource.indexOf('}', end + 1)) {
    const candidate = appSource.slice(start, end + 1);
    try {
      new vm.Script(candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  throw new Error(`Could not extract app function ${name}`);
}

function harness(names, globals) {
  const context = vm.createContext(globals);
  for (const name of names) vm.runInContext(actualFunction(name), context);
  return context;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('a saved video remains added when its follow-up metadata request fails', async () => {
  let uploads = 0;
  const uploaded = { id: 'saved-video', title: 'Movie', category: 'movie' };
  const state = {
    uploading: false, titles: [], uploadCategory: 'home', preset: null,
    uploadItems: [{ file: { name: 'movie.mp4' }, status: 'queued', progress: 0 }],
  };
  const context = harness(['mergeTitle', 'processQueue'], {
    state, AbortController, palettes: { amber: [] },
    api: {
      async upload() { uploads++; return uploaded; },
      async update() {
        assert.equal(state.titles[0].id, uploaded.id, 'the saved video is retained before enrichment');
        throw new Error('metadata unavailable');
      },
    },
    renderUploadQueue() {}, renderLibrary() {}, refresh: async () => {},
    makeThumbnail: async () => null,
  });
  await context.processQueue();
  assert.equal(uploads, 1);
  assert.equal(state.titles[0].id, uploaded.id);
  assert.equal(state.uploadItems[0].status, 'done');
  assert.equal(state.uploadItems[0].uploadedId, uploaded.id);
  assert.match(state.uploadItems[0].error, /Video added.*metadata unavailable/);
  assert.equal(state.uploading, false);
  await context.processQueue();
  assert.equal(uploads, 1, 'processing the queue again must not upload a saved video twice');
});

test('a cover failure does not turn a completed video upload into a retry', async () => {
  const saved = { id: 'saved-video', title: 'Movie', category: 'home' };
  const state = {
    uploading: false, titles: [], uploadCategory: 'home', preset: null,
    uploadItems: [{ file: { name: 'movie.mp4' }, status: 'queued', progress: 0 }],
  };
  const context = harness(['mergeTitle', 'processQueue'], {
    state, AbortController, palettes: { amber: [] },
    api: {
      upload: async () => ({ ...saved, category: 'movie' }),
      update: async () => saved,
      poster: async () => { throw new Error('cover unavailable'); },
    },
    renderUploadQueue() {}, renderLibrary() {}, refresh: async () => {},
    makeThumbnail: async () => new Blob(['test cover'], { type: 'image/png' }),
  });
  await context.processQueue();
  assert.equal(state.uploadItems[0].status, 'done');
  assert.match(state.uploadItems[0].error, /Video added.*cover could not be saved/);
  assert.equal(state.titles[0].category, 'home');
});

for (const outcome of ['success', 'failure']) {
  test(`a late edit ${outcome} cannot reopen or access a replaced dialog`, async () => {
    const pending = deferred();
    const original = { id: 'movie', title: 'Movie', palette: 'amber', category: 'movie', year: null, description: '' };
    const saved = { ...original, title: 'New title' };
    const state = { titles: [original] };
    const modal = { open: true };
    const button = { disabled: false };
    const messages = [];
    let submit, detailCalls = 0;
    const form = {
      isConnected: true,
      values: { title: 'New title', category: 'movie', year: '', description: '' },
      addEventListener(name, handler) { assert.equal(name, 'submit'); submit = handler; },
      querySelector(selector) {
        assert.equal(this.isConnected, true, 'a detached edit form must not be accessed');
        if (selector === '#save-details') return button;
        throw new Error(`Unexpected access to ${selector}`);
      },
    };
    const context = harness(['mergeTitle', 'showEdit'], {
      state, modal, palettes: { amber: [] }, categories: { movie: 'Movie' },
      findTitle: () => original, escape: String, coverStyle: () => '',
      openDialog() {}, renderLibrary() {},
      showDetail() { detailCalls++; },
      toast(message) { messages.push(message); },
      $(selector) { assert.equal(selector, '#edit-form'); return form; },
      FormData: class {
        constructor(target) { assert.equal(target, form); this.values = target.values; }
        get(key) { return this.values[key]; }
      },
      api: { update: () => pending.promise },
    });
    context.showEdit(original.id);
    const result = submit({ preventDefault() {}, currentTarget: form });
    assert.equal(button.disabled, true);
    form.isConnected = false; // User closes Edit and opens another dialog.
    if (outcome === 'success') pending.resolve(saved);
    else pending.reject(new Error('metadata unavailable'));
    await result;
    assert.equal(detailCalls, 0, 'the newly opened dialog must stay in place');
    assert.equal(modal.open, true);
    if (outcome === 'success') assert.equal(state.titles[0].title, saved.title);
    else assert.match(messages.at(-1), /metadata unavailable/);
  });
}

test('the player closes immediately while its final progress save is pending', async () => {
  const pending = deferred();
  const state = { playerId: 'movie', titles: [{ id: 'movie', title: 'Movie' }] };
  const notices = [];
  let update;
  const playerDialog = { open: true, close() { this.open = false; } };
  const video = {
    duration: 120, currentTime: 42, ended: false,
    pause() {}, removeAttribute(name) { assert.equal(name, 'src'); },
    load() { this.duration = NaN; this.currentTime = 0; },
  };
  const context = harness(['mergeTitle', 'saveProgress', 'closePlayer'], {
    state, playerDialog, video, playerGeneration: 1, progressTimer: null,
    progressSequence: Promise.resolve(), clearInterval() {}, renderLibrary() {},
    findTitle: (id) => state.titles.find((item) => item.id === id),
    toast: (message) => notices.push(message),
    api: { update(id, fields) { update = { id, fields }; return pending.promise; } },
  });
  context.closePlayer();
  assert.equal(playerDialog.open, false, 'closing must not wait for the HTTP request');
  assert.equal(state.playerId, null);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(update.id, 'movie');
  assert.equal(update.fields.position, 42, 'progress is captured before clearing the video');
  assert.equal(update.fields.duration, 120);
  pending.reject(new Error('library unavailable'));
  await context.progressSequence;
  assert.match(notices.at(-1), /Watch progress wasn’t saved.*library unavailable/);
  assert.equal(playerDialog.open, false);
});

test('metadata and cover requests have a finite timeout and propagate aborts', async () => {
  const timers = [];
  const context = vm.createContext({
    AbortSignal: {
      timeout(milliseconds) {
        const controller = new AbortController();
        timers.push({ milliseconds, controller });
        return controller.signal;
      },
    },
    fetch(url, { signal }) {
      assert.ok(signal, `${url} needs a timeout signal`);
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  vm.runInContext(`${apiSource.replace(/^export /gm, '')}\nglobalThis.testApi = api;`, context);
  for (const operation of [
    () => context.testApi.update('movie', { title: 'Movie' }),
    () => context.testApi.poster('movie', new Blob(['cover'], { type: 'image/png' })),
  ]) {
    const result = operation();
    const timer = timers.at(-1);
    assert.equal(timer.milliseconds, 15000);
    timer.controller.abort(new DOMException('Request timed out', 'TimeoutError'));
    await assert.rejects(result, { name: 'TimeoutError' });
  }
});

for (const staleOutcome of ['success', 'failure']) {
  test(`a stale library ${staleOutcome} cannot replace a newer refresh`, async () => {
    const first = deferred(), second = deferred();
    const state = { titles: [], online: false, loading: true };
    const banner = { hidden: false };
    let requests = 0, renders = 0;
    const context = harness(['refresh'], {
      state, libraryGeneration: 0,
      api: {
        list: () => (++requests === 1 ? first.promise : second.promise),
        settings: async () => ({ libraryPath: 'test library' }),
      },
      $: () => banner,
      renderLibrary() { renders++; },
      toast() { assert.fail('a stale or silent refresh should not display an error'); },
    });
    const older = context.refresh({ silent: true });
    const newer = context.refresh({ silent: true });
    second.resolve([{ id: 'converted-output' }]);
    await newer;
    if (staleOutcome === 'success') first.resolve([{ id: 'original-only' }]);
    else first.reject(new Error('old request failed'));
    await older;
    assert.equal(state.titles[0].id, 'converted-output');
    assert.equal(state.online, true);
    assert.equal(banner.hidden, true);
    assert.equal(renders, 1, 'only the newest response should render');
  });
}

function conversionHarness({ library, jobs, list } = {}) {
  const state = {
    titles: [{ id: 'original', title: 'Original MKV' }],
    conversionJobs: [], conversionCheckedOutputs: new Set(),
    conversionMutation: 0, conversionPolling: false,
    online: true, loading: false,
  };
  const notices = [];
  let refreshes = 0;
  const context = harness(['findTitle', 'activeConversion', 'refresh', 'refreshConversions'], {
    state, libraryGeneration: 0, conversionTimer: null,
    clearTimeout() {}, setTimeout() { return null; },
    renderLibrary() {}, renderConversions() {},
    $: () => ({ hidden: false }),
    toast(message) { notices.push(message); },
    api: {
      conversion: async () => ({ available: true }),
      conversionJobs: async () => jobs,
      settings: async () => ({}),
      async list() { refreshes++; return list ? list() : library; },
    },
  });
  return { state, context, notices, refreshes: () => refreshes };
}

test('a completed conversion on the first poll refreshes a stale library snapshot', async () => {
  const output = { id: 'mp4-copy', title: 'Movie (MP4)' };
  const job = { id: 'conversion', status: 'completed', sourceTitleId: 'original', outputTitleId: output.id };
  const run = conversionHarness({ library: [{ id: 'original' }, output], jobs: [job] });
  await run.context.refreshConversions();
  assert.equal(run.refreshes(), 1);
  assert.equal(run.state.titles.find((title) => title.id === output.id), output);
  await run.context.refreshConversions();
  assert.equal(run.refreshes(), 1, 'an already discovered copy should not force another refresh');
});

test('a deleted converted copy is checked once rather than refreshing forever', async () => {
  const job = { id: 'old-conversion', status: 'completed', outputTitleId: 'deleted-copy' };
  const run = conversionHarness({ library: [{ id: 'original' }], jobs: [job] });
  await run.context.refreshConversions();
  await run.context.refreshConversions();
  await run.context.refreshConversions();
  assert.equal(run.refreshes(), 1);
  assert.equal(run.state.conversionCheckedOutputs.has(job.id), true);
});

test('a completed copy is checked again after a temporary library failure', async () => {
  const output = { id: 'mp4-copy' };
  const job = { id: 'conversion', status: 'completed', outputTitleId: output.id };
  let unavailable = true;
  const run = conversionHarness({
    jobs: [job],
    list() {
      if (unavailable) throw new Error('library temporarily unavailable');
      return [output];
    },
  });
  await run.context.refreshConversions();
  assert.equal(run.state.online, false);
  assert.equal(run.state.conversionCheckedOutputs.has(job.id), false);
  unavailable = false;
  await run.context.refreshConversions();
  assert.equal(run.refreshes(), 2);
  assert.equal(run.state.titles[0].id, output.id);
  assert.equal(run.state.conversionCheckedOutputs.has(job.id), true);
});

test('a stale conversion poll cannot erase a job started while it was pending', async () => {
  const capability = deferred();
  const job = { id: 'new-conversion', sourceTitleId: 'original', status: 'running' };
  const state = {
    conversionJobs: [], conversionCheckedOutputs: new Set(),
    conversionMutation: 0, conversionPolling: false,
  };
  let refreshes = 0;
  const context = harness(['activeConversion', 'refreshConversions', 'startConversion'], {
    state, conversionTimer: null, modal: { open: false },
    clearTimeout() {}, setTimeout() { return null; },
    renderConversions() {}, toast() {},
    refresh: async () => { refreshes++; },
    api: {
      conversion: () => capability.promise,
      conversionJobs: async () => [],
      convert: async () => job,
    },
  });
  const poll = context.refreshConversions();
  await context.startConversion('original');
  capability.resolve({ available: true });
  await poll;
  assert.equal(state.conversionJobs.length, 1);
  assert.equal(state.conversionJobs[0], job);
  assert.equal(state.conversionMutation, 1);
  assert.equal(refreshes, 0);
});
