#!/usr/bin/env node
/**
 * Backfill one-shot: itera por assets/watch-progress/users/<email>/data.json
 * y genera la estructura particionada al lado:
 *   - users/<email>/index.json (overview ligero)
 *   - users/<email>/titles/<imdbId>.json (detalle por título)
 *
 * Sin esperar a que llegue un nuevo issue de cada user. El sync workflow
 * sigue escribiendo ambos formatos en cada drain.
 *
 * Uso:
 *   node tools/backfill-partition-user-data.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const USERS_DIR = path.join(PROJECT_ROOT, 'assets', 'watch-progress', 'users');

async function main() {
  let dirs;
  try {
    dirs = await fs.readdir(USERS_DIR, { withFileTypes: true });
  } catch (err) {
    console.error(`[backfill] no se pudo leer ${USERS_DIR}: ${err?.message || err}`);
    process.exit(1);
  }

  const userDirs = dirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  console.log(`[backfill] ${userDirs.length} user dirs encontrados en ${USERS_DIR}`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const userDirName of userDirs) {
    const userDir = path.join(USERS_DIR, userDirName);
    const dataPath = path.join(userDir, 'data.json');
    try {
      const raw = await fs.readFile(dataPath, 'utf8');
      const payload = safeJson(raw);
      if (!payload || !payload.email) {
        console.warn(`[backfill] skip ${userDirName}: data.json sin payload válido`);
        skipped += 1;
        continue;
      }
      await writePartitionedUserFiles(userDirName, payload);
      processed += 1;
    } catch (err) {
      if (err?.code === 'ENOENT') {
        skipped += 1;
        continue;
      }
      console.error(`[backfill] fallo en ${userDirName}: ${err?.message || err}`);
      failed += 1;
    }
  }

  console.log(`[backfill] done. processed=${processed} skipped=${skipped} failed=${failed}`);
}

async function writePartitionedUserFiles(userDirName, payload) {
  const userDir = path.join(USERS_DIR, userDirName);
  const titlesDir = path.join(userDir, 'titles');
  await fs.mkdir(titlesDir, { recursive: true });

  const progress = payload?.progress && typeof payload.progress === 'object' ? payload.progress : {};
  const titleIds = Object.keys(progress).filter(Boolean).sort();

  const slimProgress = {};
  for (const id of titleIds) {
    const entry = progress[id] || {};
    slimProgress[id] = {
      imdbId: entry.imdbId || '',
      tmdbId: entry.tmdbId || '',
      lastSeason: entry.lastSeason || 1,
      lastEpisode: entry.lastEpisode || 1,
      progress: entry.progress || 0,
      lastProgress: entry.lastProgress || 0,
      updatedAt: entry.updatedAt || ''
    };
  }

  const index = {
    email: payload.email,
    name: payload.name || '',
    updatedAt: payload.updatedAt || '',
    lastWatch: payload.lastWatch || null,
    lastSelection: payload.lastSelection || null,
    preferences: payload.preferences || {},
    titles: titleIds,
    progress: slimProgress
  };
  const indexPath = path.join(userDir, 'index.json');
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

  const allHistory = Array.isArray(payload.history) ? payload.history : [];
  for (const titleId of titleIds) {
    const entry = progress[titleId] || {};
    const titleHistory = allHistory.filter((h) => String(h?.contentId || '') === titleId);
    const titlePayload = {
      imdbId: entry.imdbId || titleId,
      tmdbId: entry.tmdbId || '',
      lastSeason: entry.lastSeason || 1,
      lastEpisode: entry.lastEpisode || 1,
      progress: entry.progress || 0,
      lastProgress: entry.lastProgress || 0,
      updatedAt: entry.updatedAt || '',
      watched: entry.watched || {},
      history: titleHistory
    };
    const titlePath = path.join(titlesDir, `${sanitizeTitleId(titleId)}.json`);
    await fs.writeFile(titlePath, `${JSON.stringify(titlePayload, null, 2)}\n`, 'utf8');
  }
  console.log(`[backfill] ${userDirName}: ${titleIds.length} titles + index.json`);
}

function sanitizeTitleId(id) {
  return String(id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
}

function safeJson(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return null; }
}

main().catch((err) => {
  console.error(`[backfill] fatal: ${err?.message || err}`);
  process.exit(1);
});
