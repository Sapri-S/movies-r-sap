import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MediaError } from '../media/disk-source.mjs';

export const MAX_CATALOG_BYTES = 20 * 1024 ** 2;
export const MAX_CATALOG_ROWS = 100000;
const MAX_FIELD_LENGTH = 12000;
const CATALOG_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEADERS = ['id', 'title', 'year', 'description', 'poster_filename', 'genre'];

function invalid(message) { return new MediaError(400, 'invalid_catalog', message); }

function normalizeSearch(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function validatePosterFilename(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\\/<>:"|?*\x00-\x1f\x7f]/.test(value)
    || !/\.(?:jpe?g|png|webp)$/i.test(value.trim())) {
    throw invalid('Use a local JPEG, PNG, or WebP filename for poster_filename, without folders or a web address.');
  }
  return value.trim().normalize('NFC');
}

/** Strict RFC 4180-style CSV, with CRLF/LF, quoted newlines, and escaped quotes. */
function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let started = false;
  const finishField = () => { row.push(field); field = ''; afterQuote = false; started = false; };
  const finishRow = () => {
    finishField();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
    if (rows.length > MAX_CATALOG_ROWS + 1) throw invalid(`Import up to ${MAX_CATALOG_ROWS.toLocaleString('en-US')} catalog rows at a time.`);
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; afterQuote = true; }
      } else field += character;
    } else if (character === ',') finishField();
    else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index++;
      finishRow();
    } else if (afterQuote) throw invalid('A quoted CSV field must end with a comma or a new line.');
    else if (character === '"') {
      if (started || field) throw invalid('Quotes inside CSV values must be escaped inside a quoted field.');
      quoted = true;
      started = true;
    } else { field += character; started = true; }
    if (field.length > MAX_FIELD_LENGTH || row.length > 100) throw invalid('A CSV value or row is too long.');
  }
  if (quoted) throw invalid('The CSV ends inside a quoted field.');
  if (field || row.length || afterQuote || started) finishRow();
  return rows;
}

export function parseCatalogCsv(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_CATALOG_BYTES) {
    throw new MediaError(413, 'catalog_too_large', 'Choose a CSV of 20 MB or less.');
  }
  const rows = parseRows(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw invalid('Add a header row and at least one movie to the CSV.');
  const headers = rows.shift().map((header) => header.trim().toLowerCase());
  if (!headers.includes('title') || new Set(headers).size !== headers.length || headers.some((header) => !header)) {
    throw invalid('The CSV needs a title column and unique, nonempty column names.');
  }
  const positions = Object.fromEntries(HEADERS.map((header) => [header, headers.indexOf(header)]));
  const ids = new Set();
  return rows.map((row, index) => {
    const number = index + 2;
    if (row.length !== headers.length) throw invalid(`CSV row ${number} has a different number of values from the header.`);
    const value = (header) => positions[header] < 0 ? '' : row[positions[header]].trim();
    const title = value('title');
    const description = value('description');
    const genre = value('genre');
    if (!title || title.length > 200 || /[\x00-\x1f\x7f]/.test(title)) throw invalid(`CSV row ${number} needs a title of 1–200 characters.`);
    if (description.length > 10000 || /\x00/.test(description)) throw invalid(`CSV row ${number} needs a description of 10,000 characters or less without null characters.`);
    if (genre.length > 500 || /[\x00-\x1f\x7f]/.test(genre)) throw invalid(`CSV row ${number} needs a genre of 500 characters or less without control characters.`);
    const rawYear = value('year');
    const year = !rawYear || rawYear === '\\N' ? null : Number(rawYear);
    if (year !== null && (!/^\d{4}$/.test(rawYear) || !Number.isInteger(year) || year < 1888 || year > new Date().getFullYear() + 10)) {
      throw invalid(`CSV row ${number} needs a four-digit release year or an empty year.`);
    }
    const posterFilename = value('poster_filename') ? validatePosterFilename(value('poster_filename')) : null;
    const id = value('id') || `csv_${createHash('sha256').update(`${normalizeSearch(title)}\0${year ?? ''}`).digest('hex').slice(0, 40)}`;
    if (!CATALOG_ID.test(id)) throw invalid(`CSV row ${number} needs an id using letters, numbers, underscores, or hyphens.`);
    if (ids.has(id)) throw invalid(`CSV row ${number} duplicates a movie id. Give different editions or remakes their own id.`);
    ids.add(id);
    return { id, title, year, description, genre, posterFilename, searchTitle: normalizeSearch(title) };
  });
}

export async function readCatalogCsv(request, expectedBytes) {
  if (expectedBytes > MAX_CATALOG_BYTES) throw new MediaError(413, 'catalog_too_large', 'Choose a CSV of 20 MB or less.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_CATALOG_BYTES) throw new MediaError(413, 'catalog_too_large', 'Choose a CSV of 20 MB or less.');
    chunks.push(chunk);
  }
  if (expectedBytes !== undefined && size !== expectedBytes) throw invalid('The CSV upload was interrupted. Try again.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw invalid('Save the CSV as UTF-8 text before importing it.'); }
}

/** An offline catalog is separate from playable titles and never makes network requests. */
export function createCatalog(dataDir) {
  const connection = new DatabaseSync(path.join(dataDir, 'catalog.sqlite'));
  try {
    connection.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const version = connection.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('This movie catalog needs a newer version of Movies R Sap.');
    if (version === 0) connection.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE catalog_titles (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, year INTEGER, description TEXT NOT NULL DEFAULT '',
        genre TEXT NOT NULL DEFAULT '', search_title TEXT NOT NULL,
        poster_filename TEXT COLLATE NOCASE, updated_at TEXT NOT NULL
      );
      CREATE TABLE catalog_artwork (
        filename TEXT COLLATE NOCASE PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL
      );
      CREATE INDEX catalog_titles_search ON catalog_titles(search_title);
      CREATE INDEX catalog_titles_poster ON catalog_titles(poster_filename);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  } catch (error) { connection.close(); throw error; }
  const projection = `SELECT t.*, a.source_key AS poster_key FROM catalog_titles t
    LEFT JOIN catalog_artwork a ON a.filename = t.poster_filename`;
  const itemFromRow = (row) => row ? ({ id: row.id, title: row.title, year: row.year, description: row.description,
    genre: row.genre, posterFilename: row.poster_filename,
    poster: row.poster_key ? `/api/catalog/items/${encodeURIComponent(row.id)}/poster` : null }) : null;
  // Count the full catalog once after startup/import, then update artwork
  // counters incrementally. A 62k-image import must not rescan 62k rows per image.
  let statusSnapshot;
  function readStatus() {
    const totalTitles = connection.prepare('SELECT COUNT(*) AS count FROM catalog_titles').get().count;
    const references = connection.prepare(`SELECT COUNT(DISTINCT t.poster_filename) AS expected,
      COUNT(DISTINCT a.filename) AS present FROM catalog_titles t LEFT JOIN catalog_artwork a ON a.filename = t.poster_filename`).get();
    return { totalTitles, posterCount: references.present, posterReferences: references.expected,
      missingPosters: references.expected - references.present, localOnly: true,
      maxImportBytes: MAX_CATALOG_BYTES, maxTitles: MAX_CATALOG_ROWS };
  }
  const repository = {
    status() {
      statusSnapshot ??= readStatus();
      return { ...statusSnapshot };
    },
    knownPosterKeys() { return connection.prepare('SELECT source_key FROM catalog_artwork').all().map((row) => row.source_key); },
    importCsv(text) {
      const items = parseCatalogCsv(text);
      const existing = connection.prepare('SELECT id FROM catalog_titles');
      const ids = new Set(existing.all().map((row) => row.id));
      const inserted = items.filter((item) => !ids.has(item.id)).length;
      if (ids.size + inserted > MAX_CATALOG_ROWS) throw invalid(`The local catalog supports up to ${MAX_CATALOG_ROWS.toLocaleString('en-US')} titles.`);
      const upsert = connection.prepare(`INSERT INTO catalog_titles (id,title,year,description,genre,search_title,poster_filename,updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,year=excluded.year,
        description=excluded.description,genre=excluded.genre,search_title=excluded.search_title,
        poster_filename=excluded.poster_filename,updated_at=excluded.updated_at`);
      connection.exec('BEGIN IMMEDIATE');
      try {
        const now = new Date().toISOString();
        for (const item of items) upsert.run(item.id, item.title, item.year, item.description, item.genre, item.searchTitle, item.posterFilename, now);
        connection.exec('COMMIT');
        statusSnapshot = undefined;
      } catch (error) { connection.exec('ROLLBACK'); throw error; }
      return { imported: items.length, inserted, updated: items.length - inserted, ...repository.status(),
        posterFilenames: [...new Set(items.map((item) => item.posterFilename).filter(Boolean))] };
    },
    search(input) {
      if (Object.keys(input).some((key) => !['query', 'year'].includes(key)) || typeof input.query !== 'string'
        || !input.query.trim() || input.query.length > 200 || /[\x00-\x1f\x7f]/.test(input.query)) {
        throw invalid('Search with a movie title of 1–200 characters.');
      }
      const query = normalizeSearch(input.query);
      if (!query) throw invalid('Enter some letters or numbers from the movie title.');
      const year = input.year ?? null;
      if (year !== null && (!Number.isInteger(year) || year < 1888 || year > new Date().getFullYear() + 10)) throw invalid('Choose a valid release year.');
      return connection.prepare(`${projection} WHERE t.search_title LIKE ? AND (? IS NULL OR t.year = ?)
        ORDER BY CASE WHEN t.search_title = ? THEN 0 WHEN t.search_title LIKE ? THEN 1 ELSE 2 END,
        t.title COLLATE NOCASE, t.year DESC LIMIT 30`).all(`%${query}%`, year, year, query, `${query}%`).map(itemFromRow);
    },
    get(id) { return itemFromRow(connection.prepare(`${projection} WHERE t.id = ?`).get(id)); },
    getPosterKey(id) { return connection.prepare(`${projection} WHERE t.id = ?`).get(id)?.poster_key ?? null; },
    requirePosterFilename(filename) {
      const valid = validatePosterFilename(filename);
      const row = connection.prepare('SELECT poster_filename FROM catalog_titles WHERE poster_filename = ? LIMIT 1').get(valid);
      if (!row) throw new MediaError(404, 'catalog_poster_unreferenced', 'This filename is not referenced by a movie in the imported CSV.');
      return row.poster_filename;
    },
    setPoster(filename, sourceKey) {
      filename = repository.requirePosterFilename(filename);
      statusSnapshot ??= readStatus();
      const oldKey = connection.prepare('SELECT source_key FROM catalog_artwork WHERE filename = ?').get(filename)?.source_key;
      connection.prepare(`INSERT INTO catalog_artwork (filename,source_key,updated_at) VALUES (?,?,?)
        ON CONFLICT(filename) DO UPDATE SET source_key=excluded.source_key,updated_at=excluded.updated_at`)
        .run(filename, sourceKey, new Date().toISOString());
      if (!oldKey) { statusSnapshot.posterCount++; statusSnapshot.missingPosters--; }
      return oldKey;
    },
    close() { connection.close(); },
  };
  return repository;
}
