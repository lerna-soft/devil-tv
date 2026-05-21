#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SEED_PATH = path.join(ROOT, 'assets', 'catalog.seed.json');
const WATCH_PROGRESS_DIR = path.join(ROOT, 'assets', 'watch-progress', 'users');
const OUT_DIR = path.join(ROOT, 'assets', 'catalog');

const HOME_STREAMING_GROUPS = [
  { key: 'netflix', aliases: ['netflix'] },
  { key: 'primevideo', aliases: ['primevideo', 'amazonprimevideo', 'primevideoamazonchannel'] },
  { key: 'disneyplus', aliases: ['disneyplus', 'disneynow'] },
  { key: 'max', aliases: ['max', 'hbomax', 'hbo'] },
  { key: 'hulu', aliases: ['hulu'] },
  { key: 'appletvplus', aliases: ['appletvplus', 'appletv', 'appletvstore', 'appletvamazonchannel'] },
  { key: 'paramountplus', aliases: ['paramountplus', 'paramountplusappletvchannel'] }
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function normalizePlatformKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function titleHasProvider(entry, aliases) {
  const normalizedAliases = aliases.map((alias) => normalizePlatformKey(alias)).filter(Boolean);
  const providers = Array.isArray(entry?.watchProviders?.flatrate) ? entry.watchProviders.flatrate : [];
  return providers.some((provider) => {
    const normalized = normalizePlatformKey(provider);
    return normalizedAliases.some((alias) => normalized.includes(alias));
  });
}

function normalizeSeedEntry(entry, defaultType) {
  const type = entry?.type || defaultType;
  return {
    type,
    tmdbId: entry?.tmdbId ? String(entry.tmdbId) : '',
    imdbId: entry?.imdbId ? String(entry.imdbId) : '',
    title: entry?.title || '',
    year: Number(entry?.year) || null,
    releaseDate: entry?.releaseDate || null,
    overview: entry?.overview || entry?.description || '',
    posterUrl: entry?.posterUrl || '',
    backdropUrl: entry?.backdropUrl || null,
    genres: Array.isArray(entry?.genres) ? entry.genres : [],
    watchProviders: {
      region: entry?.watchProviders?.region || '',
      flatrate: Array.isArray(entry?.watchProviders?.flatrate) ? entry.watchProviders.flatrate : []
    }
  };
}

function dedupeById(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.type}:${item.imdbId || item.tmdbId || `${item.title}:${item.year || ''}`}`;
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function getSeedSyncKey(item) {
  const type = String(item?.type || '').trim().toLowerCase();
  const imdb = String(item?.imdbId || '').trim();
  const tmdb = String(item?.tmdbId || '').trim();
  if (!type || (!imdb && !tmdb)) return '';
  return `${type}:${imdb || tmdb}`;
}

function sortLatest(items) {
  return [...items].sort((a, b) => {
    const aDate = Date.parse(a.releaseDate || '') || 0;
    const bDate = Date.parse(b.releaseDate || '') || 0;
    return bDate - aDate || (b.year || 0) - (a.year || 0) || String(a.title).localeCompare(String(b.title), 'es', { sensitivity: 'base' });
  });
}

const seed = readJson(SEED_PATH);
const movies = (seed.movies || []).map((entry) => normalizeSeedEntry(entry, 'movie'));
const series = (seed.series || []).map((entry) => normalizeSeedEntry(entry, 'series'));
const all = dedupeById([...movies, ...series]);

const latest = sortLatest(all).slice(0, 24);
const featuredMovies = sortLatest(movies).slice(0, 12);
const featuredSeries = sortLatest(series).slice(0, 12);
const providerPreviews = {};
const providerChunks = {};

for (const group of HOME_STREAMING_GROUPS) {
  const matched = sortLatest(all.filter((entry) => titleHasProvider(entry, group.aliases || [group.key])));
  providerPreviews[group.key] = matched.slice(0, 10);
  providerChunks[group.key] = matched;
}

const bootstrap = dedupeById([
  ...latest,
  ...featuredMovies,
  ...featuredSeries,
  ...Object.values(providerPreviews).flat()
]);

const idIndex = new Map();
for (const item of all) {
  const ids = [item.imdbId, item.tmdbId].filter(Boolean);
  for (const id of ids) idIndex.set(String(id), item);
}

const userDirExists = fs.existsSync(WATCH_PROGRESS_DIR);
const userFiles = userDirExists
  ? fs.readdirSync(WATCH_PROGRESS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(entry.name, 'data.json'))
      .filter((file) => fs.existsSync(path.join(WATCH_PROGRESS_DIR, file)))
  : [];
const userManifests = [];

for (const file of userFiles) {
  const data = readJson(path.join(WATCH_PROGRESS_DIR, file));
  const ids = new Set();
  const collect = (value) => { if (value) ids.add(String(value)); };
  Object.keys(data?.preferences?.likes || {}).forEach(collect);
  Object.keys(data?.preferences?.watchLater || {}).forEach(collect);
  Object.keys(data?.progress || {}).forEach(collect);
  collect(data?.lastWatch?.imdbId);
  collect(data?.lastWatch?.tmdbId);
  collect(data?.lastSelection?.imdbId);
  collect(data?.lastSelection?.tmdbId);
  for (const row of data?.history || []) {
    collect(row?.imdbId);
    collect(row?.tmdbId);
  }
  const items = dedupeById([...ids].map((id) => idIndex.get(id)).filter(Boolean));
  const email = String(data?.email || '').trim().toLowerCase();
  if (!email || !items.length) continue;
  const relPath = `users/${email}.json`;
  writeJson(path.join(OUT_DIR, relPath), {
    version: Number(seed.version || 0),
    email,
    count: items.length,
    items
  });
  userManifests.push({ email, path: relPath, count: items.length });
}

writeJson(path.join(OUT_DIR, 'bootstrap.json'), {
  version: Number(seed.version || 0),
  count: bootstrap.length,
  items: bootstrap
});

writeJson(path.join(OUT_DIR, 'movies.json'), {
  version: Number(seed.version || 0),
  type: 'movie',
  count: movies.length,
  items: movies
});

writeJson(path.join(OUT_DIR, 'series.json'), {
  version: Number(seed.version || 0),
  type: 'series',
  count: series.length,
  items: series
});

for (const [key, items] of Object.entries(providerChunks)) {
  writeJson(path.join(OUT_DIR, 'platforms', `${key}.json`), {
    version: Number(seed.version || 0),
    key,
    count: items.length,
    items
  });
}

writeJson(path.join(OUT_DIR, 'index.json'), {
  version: Number(seed.version || 0),
  seedKeys: all.map((item) => getSeedSyncKey(item)).filter(Boolean),
  bootstrap: { path: 'bootstrap.json', count: bootstrap.length },
  chunks: {
    movie: { path: 'movies.json', count: movies.length },
    series: { path: 'series.json', count: series.length }
  },
  platforms: Object.fromEntries(Object.entries(providerChunks).map(([key, items]) => [key, {
    path: `platforms/${key}.json`,
    count: items.length,
    previewCount: (providerPreviews[key] || []).length
  }])),
  users: userManifests
});

console.log(`Catalog chunks written to ${path.relative(ROOT, OUT_DIR)}`);
console.log(`bootstrap=${bootstrap.length} movies=${movies.length} series=${series.length} users=${userManifests.length}`);
