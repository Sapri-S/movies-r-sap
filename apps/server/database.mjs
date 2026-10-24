import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1;

/** SQLite owns metadata only. Media paths are portable keys resolved by a source. */
export function createDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, 'library.sqlite');
  const connection = new DatabaseSync(filePath);
  try {
    connection.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const currentVersion = connection.prepare('PRAGMA user_version').get().user_version;
    if (currentVersion > SCHEMA_VERSION) throw new Error('This library was created by a newer version of Movies R Sap. Update the app before opening it.');
    if (currentVersion === 0) connection.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE titles (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'movie' CHECK(category IN ('movie','tv','home')),
        year INTEGER,
        description TEXT NOT NULL DEFAULT '',
        palette TEXT NOT NULL DEFAULT 'amber',
        duration REAL NOT NULL DEFAULT 0 CHECK(duration >= 0),
        position REAL NOT NULL DEFAULT 0 CHECK(position >= 0),
        completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
        watchlist INTEGER NOT NULL DEFAULT 0 CHECK(watchlist IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE media_assets (
        id TEXT PRIMARY KEY,
        title_id TEXT NOT NULL UNIQUE REFERENCES titles(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL DEFAULT 'local',
        source_key TEXT NOT NULL UNIQUE,
        poster_key TEXT,
        original_name TEXT NOT NULL,
        file_size INTEGER NOT NULL CHECK(file_size >= 0),
        mime_type TEXT NOT NULL
      );
      CREATE INDEX titles_created ON titles(created_at DESC);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  } catch (error) {
    connection.close();
    throw error;
  }

  const select = `SELECT t.*, a.id AS asset_id, a.original_name, a.file_size, a.mime_type,
    a.source_id, a.source_key, a.poster_key FROM titles t LEFT JOIN media_assets a ON a.title_id = t.id`;
  const byId = connection.prepare(`${select} WHERE t.id = ?`);
  const all = connection.prepare(`${select} ORDER BY t.created_at DESC, t.rowid DESC`);
  const assetById = connection.prepare('SELECT * FROM media_assets WHERE title_id = ?');
  const titleFromRow = (row) => row ? {
    id: row.id,
    title: row.title,
    category: row.category,
    year: row.year,
    description: row.description,
    poster: row.poster_key ? `/api/titles/${encodeURIComponent(row.id)}/poster` : null,
    palette: row.palette,
    originalName: row.original_name ?? null,
    fileSize: row.file_size ?? 0,
    mimeType: row.mime_type ?? '',
    duration: row.duration,
    position: row.position,
    completed: Boolean(row.completed),
    watchlist: Boolean(row.watchlist),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    available: Boolean(row.source_key),
  } : null;
  const assetFromRow = (row) => row ? {
    id: row.id,
    titleId: row.title_id,
    sourceId: row.source_id,
    sourceKey: row.source_key,
    posterKey: row.poster_key,
    originalName: row.original_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
  } : null;

  function transaction(work) {
    connection.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      connection.exec('COMMIT');
      return result;
    } catch (error) {
      try { connection.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }
  const repository = {
    filePath,
    schemaVersion: SCHEMA_VERSION,
    listTitles: () => all.all().map(titleFromRow),
    getTitle: (id) => titleFromRow(byId.get(id)),
    getAsset: (id) => assetFromRow(assetById.get(id)),
    createTitle(title, asset) {
      return transaction(() => {
        const now = new Date().toISOString();
        const id = title.id || randomUUID();
        connection.prepare(`INSERT INTO titles
          (id,title,category,year,description,palette,duration,position,completed,watchlist,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, title.title, title.category || 'movie', title.year ?? null,
          title.description || '', title.palette || 'amber', title.duration || 0, title.position || 0,
          Number(Boolean(title.completed)), Number(Boolean(title.watchlist)), title.createdAt || now, now);
        connection.prepare(`INSERT INTO media_assets
          (id,title_id,source_id,source_key,poster_key,original_name,file_size,mime_type)
          VALUES (?,?,?,?,?,?,?,?)`).run(asset.id || randomUUID(), id, asset.sourceId || 'local', asset.sourceKey,
          asset.posterKey || null, asset.originalName, asset.fileSize, asset.mimeType);
        return repository.getTitle(id);
      });
    },
    updateTitle(id, changes) {
      const columns = { title: 'title', category: 'category', year: 'year', description: 'description', palette: 'palette',
        duration: 'duration', position: 'position', completed: 'completed', watchlist: 'watchlist' };
      const entries = Object.entries(changes).filter(([key]) => Object.hasOwn(columns, key));
      if (entries.length) {
        const values = entries.map(([key, value]) => key === 'completed' || key === 'watchlist' ? Number(value) : value);
        connection.prepare(`UPDATE titles SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...values, new Date().toISOString(), id);
      }
      return repository.getTitle(id);
    },
    setPoster(id, posterKey) {
      return transaction(() => {
        connection.prepare('UPDATE media_assets SET poster_key = ? WHERE title_id = ?').run(posterKey, id);
        connection.prepare('UPDATE titles SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        return repository.getTitle(id);
      });
    },
    applyCatalogMetadata(id, changes, posterKey = undefined) {
      return transaction(() => {
        repository.updateTitle(id, changes);
        if (posterKey !== undefined) connection.prepare('UPDATE media_assets SET poster_key = ? WHERE title_id = ?').run(posterKey, id);
        return repository.getTitle(id);
      });
    },
    patchTitle(id, changes, clearPoster = false) {
      return transaction(() => {
        repository.updateTitle(id, changes);
        if (clearPoster) {
          connection.prepare('UPDATE media_assets SET poster_key = NULL WHERE title_id = ?').run(id);
          connection.prepare('UPDATE titles SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        }
        return repository.getTitle(id);
      });
    },
    deleteTitle(id) {
      return transaction(() => {
        const asset = repository.getAsset(id);
        connection.prepare('DELETE FROM titles WHERE id = ?').run(id);
        return asset;
      });
    },
    exportMetadata() {
      return {
        format: 'movies-r-sap',
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        sources: [{ id: 'local', type: 'managed-disk', root: 'media' }],
        titles: repository.listTitles(),
        assets: connection.prepare('SELECT * FROM media_assets ORDER BY title_id').all().map(assetFromRow),
      };
    },
    close() {
      connection.close();
    },
  };
  return repository;
}
