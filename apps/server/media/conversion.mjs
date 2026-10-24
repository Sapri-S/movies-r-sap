import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, readFile, writeFile, rename, rm, stat, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { MediaError, MAX_VIDEO_BYTES } from './disk-source.mjs';

const RESERVE_BYTES = 256 * 1024 ** 2;
const MAX_HISTORY = 20;
const PROFILE = 'MP4 (H.264 video + AAC audio)';

/** The process boundary is deliberately an argument array, never a shell command. */
async function execute(executable, args, { signal, onLine = () => {} } = {}) {
  if (signal?.aborted) throw new Error('Conversion canceled.');
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const buffers = new Map();
    let killTimer;
    const abort = () => {
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    for (const stream of [child.stdout, child.stderr]) {
      buffers.set(stream, '');
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const text = buffers.get(stream) + chunk;
        const lines = text.split(/[\r\n]+/);
        buffers.set(stream, lines.pop().slice(-16384));
        for (const line of lines) onLine(line.slice(0, 16384));
      });
    }
    const cleanup = () => { clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code) => {
      cleanup();
      if (signal?.aborted) reject(new Error('Conversion canceled.'));
      else if (code !== 0) reject(new Error('The video could not be converted. It may be damaged, protected, or use an unsupported format.'));
      else resolve();
    });
    if (signal?.aborted) abort();
  });
}

export async function createFfmpegEngine(ffmpegPath) {
  if (!ffmpegPath) {
    try { ffmpegPath = (await import('ffmpeg-static')).default; } catch { /* Optional until the dependency/runtime is installed. */ }
  }
  let available = false;
  if (typeof ffmpegPath === 'string' && path.isAbsolute(ffmpegPath)) {
    try { await access(ffmpegPath, constants.F_OK); available = true; } catch { /* Honest unavailable state. */ }
  }
  return {
    available,
    reason: available ? undefined : 'The local video converter is not installed. Install app dependencies or use the updated desktop build.',
    async run({ inputPath, outputPath, signal, onProgress }) {
      let duration = 0;
      let convertedSeconds = 0;
      let encodedFrames = 0;
      await execute(ffmpegPath, ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
        '-i', inputPath, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
        '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', outputPath], {
        signal,
        onLine(line) {
          const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
          if (match) duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
          const frame = /^frame=(\d+)/.exec(line);
          if (frame) encodedFrames = Math.max(encodedFrames, Number(frame[1]));
          const progress = /^out_time_us=(\d+)/.exec(line);
          if (progress) {
            convertedSeconds = Number(progress[1]) / 1e6;
            if (duration > 0) onProgress(Math.min(0.97, convertedSeconds / duration * 0.97));
          }
        },
      });
      if (!encodedFrames) throw new Error('The video could not be converted because no video frames were produced.');
      if (duration > 2 && convertedSeconds < duration * 0.9) {
        throw new Error('Conversion ended before the full video was written. The original has been kept.');
      }
      onProgress(0.98);
      // Do not publish a container that cannot decode even its first video frame.
      let verifiedFrames = 0;
      await execute(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe',
        '-i', outputPath, '-map', '0:v:0', '-frames:v', '1', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'], {
        signal,
        onLine(line) {
          const frame = /^frame=(\d+)/.exec(line);
          if (frame) verifiedFrames = Math.max(verifiedFrames, Number(frame[1]));
        },
      });
      if (!verifiedFrames) throw new Error('The video could not be converted into a playable MP4.');
      onProgress(0.99);
    },
  };
}

/** One local conversion at a time; finished records survive reopening the app. */
export async function createConversionManager({ dataDir, source, engine, ffmpegPath, publish }) {
  engine ||= await createFfmpegEngine(ffmpegPath);
  const historyPath = path.join(dataDir, 'conversion-jobs.json');
  let jobs = [];
  try {
    const saved = JSON.parse(await readFile(historyPath, 'utf8'));
    if (Array.isArray(saved)) jobs = saved.filter((job) => job && /^[a-f0-9-]{36}$/.test(job.id)
      && typeof job.sourceTitleId === 'string' && typeof job.sourceTitle === 'string'
      && ['running', 'queued', 'completed', 'failed', 'canceled', 'interrupted'].includes(job.status)).slice(-MAX_HISTORY);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Conversion history could not be read:', error.message);
  }
  for (const job of jobs) {
    if (job.status === 'running' || job.status === 'queued') {
      job.status = 'interrupted';
      job.error = 'The app closed before conversion finished. Your original is unchanged; start a new conversion to try again.';
      job.updatedAt = new Date().toISOString();
      job.cancelRequested = false;
    }
  }
  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (entry.isFile() && /^conversion-jobs-[a-f0-9-]+\.tmp$/.test(entry.name)) await rm(path.join(dataDir, entry.name), { force: true });
  }
  let active = null;
  let closing = false;
  let writing = Promise.resolve();
  let lastProgressWrite = 0;
  const snapshot = (job) => job ? structuredClone(job) : null;
  function persist() {
    const body = JSON.stringify(jobs);
    writing = writing.catch(() => {}).then(async () => {
      const temporary = path.join(dataDir, `conversion-jobs-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, body, { flag: 'wx', mode: 0o600, flush: true });
        await rename(temporary, historyPath);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    return writing;
  }
  await persist();
  function update(job, changes, save = true) {
    Object.assign(job, changes, { updatedAt: new Date().toISOString() });
    if (save) persist().catch((error) => console.error('Conversion history could not be saved:', error.message));
  }
  async function perform(state) {
    const { job, controller, input } = state;
    const temporary = path.join(source.tempPath, `conversion-${job.id}.mp4.part`);
    let monitor;
    let checking = false;
    let storageError = null;
    try {
      monitor = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          const [remaining, output] = await Promise.all([source.freeBytes(), stat(temporary).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          })]);
          if (remaining !== null && remaining < RESERVE_BYTES) storageError = 'There is not enough free disk space to finish conversion.';
          if (output?.size > MAX_VIDEO_BYTES) storageError = 'The converted file exceeded the 100 GB limit.';
          if (storageError) controller.abort();
        } catch { storageError = 'The library disk could not be checked. Conversion was stopped to protect your files.'; controller.abort(); }
        finally { checking = false; }
      }, 1000);
      monitor.unref();
      await engine.run({ inputPath: input.filePath, outputPath: temporary, signal: controller.signal,
        onProgress(value) {
          if (!Number.isFinite(value) || value < 0) return;
          const progress = Math.max(job.progress, Math.min(99, Math.round(value * 100)));
          const save = Date.now() - lastProgressWrite > 2000;
          if (save) lastProgressWrite = Date.now();
          update(job, { progress }, save);
        } });
      if (controller.signal.aborted) throw new Error('Conversion canceled.');
      const [remaining, output] = await Promise.all([source.freeBytes(), stat(temporary)]);
      if ((remaining !== null && remaining < RESERVE_BYTES) || output.size > MAX_VIDEO_BYTES) {
        storageError = 'There is not enough disk space for the converted movie, or it exceeded the 100 GB limit.';
        throw new Error(storageError);
      }
      state.publishing = true;
      const result = await publish({ temporary, input });
      update(job, { status: 'completed', progress: 100, outputTitleId: result.id, cancelRequested: false });
    } catch (error) {
      const canceled = controller.signal.aborted && !storageError;
      const safeMessage = storageError || (error instanceof MediaError ? error.message
        : ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? 'The converter or one of its video files could not be opened. Update the app and try again.'
          : error.message?.startsWith('The video could not be converted') || error.message?.startsWith('Conversion ended before') ? error.message
            : 'Conversion failed. The file may be damaged or unsupported. Your original has been kept.');
      update(job, { status: canceled ? 'canceled' : 'failed', error: canceled ? null : safeMessage, cancelRequested: false });
    } finally {
      clearInterval(monitor);
      await rm(temporary, { force: true }).catch(() => {});
      if (active === state) active = null;
      await writing.catch(() => {});
    }
  }
  return {
    capability: () => ({ available: Boolean(engine.available), profile: PROFILE,
      ...(engine.available ? {} : { reason: engine.reason || 'The local video converter is not installed.' }) }),
    list: () => jobs.map(snapshot).reverse(),
    isUsing: (id) => active?.job.sourceTitleId === id,
    async start(input) {
      if (closing) throw new MediaError(503, 'shutting_down', 'The app is closing.');
      if (!engine.available) throw new MediaError(503, 'converter_unavailable', engine.reason || 'The local video converter is not installed.');
      if (active) throw new MediaError(409, 'conversion_busy', 'Another movie is already being converted. Wait for it to finish or cancel it first.');
      const now = new Date().toISOString();
      const job = { id: randomUUID(), sourceTitleId: input.title.id, sourceTitle: input.title.title,
        status: 'running', progress: 0, outputTitleId: null, error: null, cancelRequested: false, createdAt: now, updatedAt: now };
      const state = { job, input, controller: new AbortController(), publishing: false, operation: null };
      active = state;
      try {
        const free = await source.freeBytes();
        if (free !== null && free < input.size + RESERVE_BYTES) throw new MediaError(507, 'disk_full', 'Free up at least the original video’s size plus 256 MB before converting. The MP4 copy needs additional space.');
        jobs.push(job);
        jobs = jobs.slice(-MAX_HISTORY);
        await persist();
      } catch (error) { active = null; jobs = jobs.filter((item) => item !== job); throw error; }
      state.operation = perform(state);
      return snapshot(job);
    },
    async cancel(id) {
      const job = jobs.find((item) => item.id === id);
      if (!job) throw new MediaError(404, 'conversion_not_found', 'This conversion is no longer in the recent job history.');
      if (active?.job === job && !active.publishing) {
        update(job, { cancelRequested: true });
        active.controller.abort();
      }
      return snapshot(job);
    },
    async close() {
      closing = true;
      if (active && !active.publishing) active.controller.abort();
      await active?.operation;
      await writing.catch(() => {});
    },
  };
}
