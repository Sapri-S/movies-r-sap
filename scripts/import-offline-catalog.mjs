import { parseArgs } from 'node:util';
import { readFile, readdir, lstat, mkdir } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseCatalogCsv, MAX_CATALOG_BYTES } from '../apps/server/metadata/catalog.mjs';

// An explicit one-time local import; no online provider or file-path API is
// exposed by the application. The server continues to validate every image.
const { values } = parseArgs({ options: {
  url: { type: 'string' }, directory: { type: 'string' }, limit: { type: 'string', default: '0' },
} });
if (!values.url) throw new Error('Pass --url http://127.0.0.1:PORT for the running Movies R Sap app.');
const origin = new URL(values.url);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port ||
    origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('Use only the app’s HTTP loopback origin, including its port.');
}
const limit = Number(values.limit);
if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('--limit must be a nonnegative integer.');
const root = resolve(values.directory || join(dirname(fileURLToPath(import.meta.url)), '../catalog-imports/posterlens-25m'));
const csvPath = join(root, 'movies.csv');
if ((await lstat(csvPath)).size > MAX_CATALOG_BYTES) throw new Error('The catalog CSV exceeds the supported size.');
const csv = await readFile(csvPath);
const rows = parseCatalogCsv(new TextDecoder('utf-8', { fatal: true }).decode(csv));
const csvHash = createHash('sha256').update(csv).digest('hex');

async function request(route, { body, headers, method = 'GET' } = {}) {
  const response = await fetch(new URL(`/api${route}`, origin), {
    method, body, headers, signal: AbortSignal.timeout(120000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || result.error || `Import request failed (${response.status}).`);
  return result;
}
const health = await request('/health');
if (!health.ok) throw new Error('The selected origin is not a healthy Movies R Sap server.');
const settings = await request('/settings');
const previous = await request('/catalog');
if (previous.maxTitles < rows.length) throw new Error('Update the desktop build before importing the full 25M catalog.');
const library = settings.libraryPath;
if (!library) throw new Error('The app did not identify its local library.');
const imported = await request('/catalog/import', { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
console.log(`Catalog: ${imported.totalTitles.toLocaleString()} movie names; uploaded videos are unchanged.`);

const checkpointPath = join(root, 'import-checkpoint.json');
let checkpoint;
try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); } catch { /* First run. */ }
if (!checkpoint || checkpoint.library !== library || checkpoint.csvHash !== csvHash ||
    !checkpoint.files || previous.posterCount < Object.keys(checkpoint.files).length) {
  checkpoint = { library, csvHash, files: {} };
}
await mkdir(root, { recursive: true });
function saveCheckpoint() {
  writeFileSync(`${checkpointPath}.tmp`, JSON.stringify(checkpoint));
  renameSync(`${checkpointPath}.tmp`, checkpointPath);
}
const referenced = new Set(rows.map((row) => row.posterFilename).filter(Boolean));
const postersRoot = join(root, 'posters');
const available = (await readdir(postersRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && referenced.has(entry.name)).map((entry) => entry.name);
const jobs = limit ? available.slice(0, limit) : available;
let cursor = 0, completed = 0, resumed = 0, failed = 0, stopped = false, consecutiveErrors = 0;
let lastReport = Date.now();
const failures = [];
process.once('SIGINT', () => { stopped = true; console.log('Finishing current uploads and saving progress…'); });
async function worker() {
  while (!stopped && cursor < jobs.length) {
    const filename = jobs[cursor++];
    try {
      const filePath = join(postersRoot, filename);
      const stat = await lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 3 || stat.size > 10 * 1024 ** 2) {
        throw new Error('Choose a regular local image no larger than 10 MB.');
      }
      const fingerprint = `${stat.size}:${stat.mtimeMs}`;
      if (checkpoint.files[filename] === fingerprint) resumed++;
      else {
        const type = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
          [filename.slice(filename.lastIndexOf('.')).toLowerCase()];
        if (!type) throw new Error('Unsupported poster type.');
        await request('/catalog/posters', { method: 'POST', body: await readFile(filePath), headers: {
          'Content-Type': type, 'X-File-Name': encodeURIComponent(filename),
        } });
        checkpoint.files[filename] = fingerprint;
      }
      completed++;
      consecutiveErrors = 0;
    } catch (error) {
      failed++;
      if (failures.length < 20) failures.push(`${filename}: ${error.message}`);
      if (++consecutiveErrors >= 5) stopped = true;
    }
    if (Date.now() - lastReport >= 10000) {
      saveCheckpoint();
      console.log(`Imported posters: ${completed}/${jobs.length}; reused: ${resumed}; failed: ${failed}`);
      lastReport = Date.now();
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
saveCheckpoint();
const status = await request('/catalog');
console.log(JSON.stringify({ ...status, availableFiles: available.length, completed, resumed, failed,
  stopped, failures }, null, 2));
if (failed || stopped) process.exitCode = 1;
