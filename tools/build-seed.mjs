#!/usr/bin/env node
/**
 * Builds assets/catalog.seed.json using TMDB discover endpoints.
 *
 * Usage:
 *   TMDB_API_KEY=... node tools/build-seed.mjs
 *
 * Optional:
 *   SEED_FROM_YEAR=2000
 *   SEED_TO_YEAR=2026
 *   SEED_MOVIES=1000
 *   SEED_SERIES=1000
 *   SEED_LANG=es-ES
 *   SEED_FALLBACK_LANG=en-US
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(PROJECT_ROOT, 'assets', 'catalog.seed.json');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
if (!TMDB_API_KEY) {
  console.error('Missing TMDB_API_KEY. Example: TMDB_API_KEY=... node tools/build-seed.mjs');
  process.exit(2);
}

const FROM_YEAR = Number(process.env.SEED_FROM_YEAR || '2000');
const TO_YEAR = Number(process.env.SEED_TO_YEAR || String(new Date().getFullYear()));
const TARGET_MOVIES = Number(process.env.SEED_MOVIES || '1000');
const TARGET_SERIES = Number(process.env.SEED_SERIES || '1000');
const LANG = process.env.SEED_LANG || 'es-ES';
const FALLBACK_LANG = process.env.SEED_FALLBACK_LANG || 'en-US';
const PROVIDERS_REGION = process.env.SEED_PROVIDERS_REGION || 'CO';
const SEED_VERSION = Number(process.env.SEED_VERSION || '2');

const MOVIES_PER_YEAR = Math.max(1, Math.ceil(TARGET_MOVIES / Math.max(1, (TO_YEAR - FROM_YEAR + 1))));
const SERIES_PER_YEAR = Math.max(1, Math.ceil(TARGET_SERIES / Math.max(1, (TO_YEAR - FROM_YEAR + 1))));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

function pickYear(dateString) {
  if (!dateString) return null;
  const year = Number(String(dateString).slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

function normalizeGenres(genreIds, genreIndex) {
  const ids = Array.isArray(genreIds) ? genreIds : [];
  return ids.map((id) => genreIndex.get(id)).filter(Boolean);
}

async function getGenreIndex(type, language) {
  const url = `https://api.themoviedb.org/3/genre/${type}/list?language=${encodeURIComponent(language)}`;
  const payload = await tmdbJson(url);
  const index = new Map();
  for (const entry of payload.genres ?? []) {
    if (entry?.id && entry?.name) index.set(entry.id, entry.name);
  }
  return index;
}

async function discoverTopForYear(kind, year, language, count, genreIndex) {
  // Using vote_count + popularity mix to avoid noisy "vote_average" spikes.
  // We page until we get enough unique titles.
  const results = [];
  const seen = new Set();

  const pageSize = 20;
  const neededPages = Math.min(25, Math.ceil(count / pageSize) + 2);

  for (let page = 1; page <= neededPages; page++) {
    const base = kind === 'movie'
      ? `https://api.themoviedb.org/3/discover/movie?language=${encodeURIComponent(language)}&sort_by=popularity.desc&include_adult=false&include_video=false&page=${page}&primary_release_year=${year}&vote_count.gte=50`
      : `https://api.themoviedb.org/3/discover/tv?language=${encodeURIComponent(language)}&sort_by=popularity.desc&page=${page}&first_air_date_year=${year}&vote_count.gte=30`;

    const payload = await tmdbJson(base);
    for (const item of payload.results ?? []) {
      const id = item?.id ? String(item.id) : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const title = kind === 'movie' ? (item.title || '') : (item.name || '');
      const date = kind === 'movie' ? item.release_date : item.first_air_date;
      results.push({
        type: kind === 'movie' ? 'movie' : 'series',
        tmdbId: id,
        imdbId: null,
        title,
        year: pickYear(date),
        releaseDate: date || null,
        overview: item.overview || null,
        posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
        backdropUrl: item.backdrop_path ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}` : null,
        genres: normalizeGenres(item.genre_ids, genreIndex)
      });
      if (results.length >= count) return results;
    }
    await sleep(120);
  }

  return results;
}

async function attachExternalIds(items, kind) {
  // External IDs are fetched per item; we do it only for the final list for speed.
  const out = [];
  for (const item of items) {
    try {
      const url = kind === 'movie'
        ? `https://api.themoviedb.org/3/movie/${encodeURIComponent(item.tmdbId)}/external_ids`
        : `https://api.themoviedb.org/3/tv/${encodeURIComponent(item.tmdbId)}/external_ids`;
      const payload = await tmdbJson(url);
      out.push({ ...item, imdbId: payload.imdb_id || null });
    } catch {
      out.push(item);
    }
    await sleep(60);
  }
  return out;
}

async function backfillMissingLanguage(items, kind) {
  // If Spanish returns empty overview/title for some items, refetch details in fallback language.
  const out = [];
  for (const item of items) {
    if ((item.title && item.title.trim()) && (item.overview && item.overview.trim())) {
      out.push(item);
      continue;
    }
    try {
      const url = kind === 'movie'
        ? `https://api.themoviedb.org/3/movie/${encodeURIComponent(item.tmdbId)}?language=${encodeURIComponent(FALLBACK_LANG)}`
        : `https://api.themoviedb.org/3/tv/${encodeURIComponent(item.tmdbId)}?language=${encodeURIComponent(FALLBACK_LANG)}`;
      const payload = await tmdbJson(url);
      const title = kind === 'movie' ? (payload.title || item.title) : (payload.name || item.title);
      const date = kind === 'movie' ? (payload.release_date || item.releaseDate) : (payload.first_air_date || item.releaseDate);
      out.push({
        ...item,
        title,
        releaseDate: date || item.releaseDate,
        year: item.year ?? pickYear(date),
        overview: payload.overview || item.overview
      });
    } catch {
      out.push(item);
    }
    await sleep(60);
  }
  return out;
}

async function attachWatchProviders(items, kind, region) {
  const out = [];
  for (const item of items) {
    try {
      const url = kind === 'movie'
        ? `https://api.themoviedb.org/3/movie/${encodeURIComponent(item.tmdbId)}/watch/providers`
        : `https://api.themoviedb.org/3/tv/${encodeURIComponent(item.tmdbId)}/watch/providers`;
      const payload = await tmdbJson(url);
      const regionPayload = payload?.results?.[region] || null;
      const flatrate = Array.isArray(regionPayload?.flatrate)
        ? regionPayload.flatrate.map((entry) => entry?.provider_name).filter(Boolean)
        : [];
      out.push({
        ...item,
        watchProviders: {
          region,
          flatrate
        }
      });
    } catch {
      out.push(item);
    }
    await sleep(60);
  }
  return out;
}

function dedupeByTmdb(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.type}:${item.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function main() {
  console.log(`Building seed from ${FROM_YEAR} to ${TO_YEAR}`);
  console.log(`Target movies=${TARGET_MOVIES}, series=${TARGET_SERIES}`);
  console.log(`Top per year movies=${MOVIES_PER_YEAR}, series=${SERIES_PER_YEAR}`);
  console.log(`Language=${LANG}, fallback=${FALLBACK_LANG}`);

  const movieGenres = await getGenreIndex('movie', LANG);
  const tvGenres = await getGenreIndex('tv', LANG);

  const movies = [];
  const series = [];

  for (let year = TO_YEAR; year >= FROM_YEAR; year--) {
    if (movies.length < TARGET_MOVIES) {
      const chunk = await discoverTopForYear('movie', year, LANG, MOVIES_PER_YEAR, movieGenres);
      movies.push(...chunk);
      console.log(`movies: ${movies.length}/${TARGET_MOVIES} (year ${year})`);
    }
    if (series.length < TARGET_SERIES) {
      const chunk = await discoverTopForYear('tv', year, LANG, SERIES_PER_YEAR, tvGenres);
      series.push(...chunk);
      console.log(`series: ${series.length}/${TARGET_SERIES} (year ${year})`);
    }
    if (movies.length >= TARGET_MOVIES && series.length >= TARGET_SERIES) break;
  }

  const finalMovies = dedupeByTmdb(movies).slice(0, TARGET_MOVIES);
  const finalSeries = dedupeByTmdb(series).slice(0, TARGET_SERIES);

  console.log('Attaching IMDb IDs (external_ids)...');
  const moviesWithIds = await attachExternalIds(finalMovies, 'movie');
  const seriesWithIds = await attachExternalIds(finalSeries, 'tv');

  console.log('Backfilling missing language fields (if any)...');
  const moviesBackfilled = await backfillMissingLanguage(moviesWithIds, 'movie');
  const seriesBackfilled = await backfillMissingLanguage(seriesWithIds, 'tv');
  console.log(`Attaching watch providers (region=${PROVIDERS_REGION})...`);
  const moviesWithProviders = await attachWatchProviders(moviesBackfilled, 'movie', PROVIDERS_REGION);
  const seriesWithProviders = await attachWatchProviders(seriesBackfilled, 'tv', PROVIDERS_REGION);

  const payload = {
    version: SEED_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      provider: 'tmdb',
      strategy: 'top_per_year',
      fromYear: FROM_YEAR,
      toYear: TO_YEAR,
      moviesPerYear: MOVIES_PER_YEAR,
      seriesPerYear: SERIES_PER_YEAR,
      targetMovies: TARGET_MOVIES,
      targetSeries: TARGET_SERIES,
      language: LANG,
      fallbackLanguage: FALLBACK_LANG,
      providersRegion: PROVIDERS_REGION
    },
    movies: moviesWithProviders,
    series: seriesWithProviders
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${OUT_PATH}`);
}

await main();
