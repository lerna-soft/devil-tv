#!/usr/bin/env node
/**
 * Adds or updates catalog.seed.json entries for a specific streaming provider.
 *
 * Usage:
 *   TMDB_API_KEY=... node tools/boost-provider-seed.mjs
 *
 * Optional:
 *   SEED_PROVIDERS_REGION=CO
 *   PROVIDER_QUERY=disney
 *   TARGET_PROVIDER_MOVIES=120
 *   TARGET_PROVIDER_SERIES=120
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SEED_PATH = path.join(PROJECT_ROOT, 'assets', 'catalog.seed.json');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
if (!TMDB_API_KEY) {
  console.error('Missing TMDB_API_KEY');
  process.exit(2);
}

const REGION = String(process.env.SEED_PROVIDERS_REGION || 'CO').toUpperCase();
const PROVIDER_QUERY = String(process.env.PROVIDER_QUERY || 'disney').trim();
const TARGET_MOVIES = Number(process.env.TARGET_PROVIDER_MOVIES || '120');
const TARGET_SERIES = Number(process.env.TARGET_PROVIDER_SERIES || '120');
const LANG = process.env.SEED_LANG || 'es-ES';
const MOVIE_PROVIDER_ID = Number(process.env.MOVIE_PROVIDER_ID || '0');
const TV_PROVIDER_ID = Number(process.env.TV_PROVIDER_ID || '0');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''); }

async function tmdbJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${TMDB_API_KEY}`
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`TMDB ${response.status} ${response.statusText} for ${url}\n${text}`.trim());
  }
  return response.json();
}

async function getGenreIndex(type) {
  const payload = await tmdbJson(`https://api.themoviedb.org/3/genre/${type}/list?language=${encodeURIComponent(LANG)}`);
  const map = new Map();
  for (const g of payload.genres || []) map.set(Number(g.id), String(g.name || '').trim());
  return map;
}

async function findProvider(kind, explicitId = 0) {
  const payload = await tmdbJson(`https://api.themoviedb.org/3/watch/providers/${kind}?watch_region=${encodeURIComponent(REGION)}&language=${encodeURIComponent(LANG)}`);
  const list = Array.isArray(payload?.results) ? payload.results : [];
  if (explicitId > 0) {
    const byId = list.find((p) => Number(p.provider_id) === Number(explicitId));
    if (!byId?.provider_id) throw new Error(`Provider id ${explicitId} not found in ${kind}/${REGION}`);
    return { id: Number(byId.provider_id), name: String(byId.provider_name || '').trim() };
  }
  const q = norm(PROVIDER_QUERY);
  const exactPreferred = list.find((p) => norm(p.provider_name) === q || norm(p.provider_name).includes(`${q}plus`) || norm(p.provider_name).includes(`${q}plus`));
  const pick = exactPreferred || list.find((p) => norm(p.provider_name).includes(q));
  if (!pick?.provider_id) throw new Error(`Provider not found for query "${PROVIDER_QUERY}" in ${kind}/${REGION}`);
  return { id: Number(pick.provider_id), name: String(pick.provider_name || '').trim() };
}

function pickYear(dateString) {
  const year = Number(String(dateString || '').slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

async function discoverByProvider(kind, providerId, providerName, genreIndex, target) {
  const results = [];
  const seen = new Set();
  for (let page = 1; page <= 50 && results.length < target; page++) {
    const url = new URL(`https://api.themoviedb.org/3/discover/${kind}`);
    url.searchParams.set('language', LANG);
    url.searchParams.set('sort_by', 'popularity.desc');
    url.searchParams.set('page', String(page));
    url.searchParams.set('watch_region', REGION);
    url.searchParams.set('with_watch_monetization_types', 'flatrate');
    url.searchParams.set('with_watch_providers', String(providerId));
    url.searchParams.set('include_adult', 'false');
    if (kind === 'movie') url.searchParams.set('include_video', 'false');
    const payload = await tmdbJson(url.toString());
    const rows = Array.isArray(payload?.results) ? payload.results : [];
    if (rows.length === 0) break;
    for (const item of rows) {
      const tmdbId = String(item?.id || '').trim();
      if (!tmdbId || seen.has(tmdbId)) continue;
      seen.add(tmdbId);
      const title = kind === 'movie' ? String(item.title || '').trim() : String(item.name || '').trim();
      const date = kind === 'movie' ? item.release_date : item.first_air_date;
      results.push({
        type: kind === 'movie' ? 'movie' : 'series',
        tmdbId,
        imdbId: null,
        title,
        year: pickYear(date),
        releaseDate: date || null,
        overview: String(item.overview || '').trim(),
        posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
        backdropUrl: item.backdrop_path ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}` : null,
        genres: (Array.isArray(item.genre_ids) ? item.genre_ids : []).map((id) => genreIndex.get(Number(id))).filter(Boolean),
        watchProviders: { region: REGION, flatrate: [providerName] }
      });
      if (results.length >= target) break;
    }
    await sleep(100);
  }
  return results;
}

function upsertAll(seed, incoming) {
  const groups = {
    movie: Array.isArray(seed.movies) ? seed.movies : [],
    series: Array.isArray(seed.series) ? seed.series : []
  };
  let changed = 0;
  for (const entry of incoming) {
    const target = groups[entry.type];
    const idx = target.findIndex((x) => String(x.tmdbId || '') === String(entry.tmdbId || '') || (entry.imdbId && String(x.imdbId || '') === String(entry.imdbId)));
    if (idx === -1) {
      target.push(entry);
      changed += 1;
      continue;
    }
    const prev = target[idx];
    const next = {
      ...prev,
      ...entry,
      imdbId: prev.imdbId || entry.imdbId || null,
      title: prev.title || entry.title,
      overview: prev.overview || entry.overview || '',
      posterUrl: prev.posterUrl || entry.posterUrl || null,
      backdropUrl: prev.backdropUrl || entry.backdropUrl || null,
      genres: Array.isArray(prev.genres) && prev.genres.length ? prev.genres : entry.genres,
      watchProviders: entry.watchProviders || prev.watchProviders || { region: REGION, flatrate: [] }
    };
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      target[idx] = next;
      changed += 1;
    }
  }
  seed.movies = groups.movie;
  seed.series = groups.series;
  return changed;
}

function countByProvider(entries, key) {
  return entries.filter((e) => (e.watchProviders?.flatrate || []).some((name) => norm(name).includes(key))).length;
}

async function main() {
  const raw = fs.readFileSync(SEED_PATH, 'utf8');
  const seed = JSON.parse(raw);
  seed.movies = Array.isArray(seed.movies) ? seed.movies : [];
  seed.series = Array.isArray(seed.series) ? seed.series : [];

  const movieProvider = await findProvider('movie', MOVIE_PROVIDER_ID);
  const tvProvider = await findProvider('tv', TV_PROVIDER_ID);
  const movieGenres = await getGenreIndex('movie');
  const tvGenres = await getGenreIndex('tv');

  console.log(`[provider-boost] region=${REGION} query="${PROVIDER_QUERY}" movieProvider=${movieProvider.name}(${movieProvider.id}) tvProvider=${tvProvider.name}(${tvProvider.id})`);

  const [movies, series] = await Promise.all([
    discoverByProvider('movie', movieProvider.id, movieProvider.name, movieGenres, TARGET_MOVIES),
    discoverByProvider('tv', tvProvider.id, tvProvider.name, tvGenres, TARGET_SERIES)
  ]);

  const changed = upsertAll(seed, [...movies, ...series]);
  seed.version = Number(seed.version || 1) + 1;
  seed.generatedAt = new Date().toISOString();
  seed.source = {
    ...(seed.source || {}),
    providersRegion: REGION,
    providerBoost: {
      query: PROVIDER_QUERY,
      movieProvider: movieProvider.name,
      tvProvider: tvProvider.name,
      targetMovies: TARGET_MOVIES,
      targetSeries: TARGET_SERIES,
      enrichedAt: seed.generatedAt
    }
  };

  fs.writeFileSync(SEED_PATH, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');

  const key = norm(PROVIDER_QUERY);
  console.log(`[provider-boost] changed=${changed}`);
  console.log(`[provider-boost] counts movies=${countByProvider(seed.movies, key)} series=${countByProvider(seed.series, key)}`);
}

await main();
