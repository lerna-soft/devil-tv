#!/usr/bin/env node
/**
 * Adds inferred Disney+ movies to assets/catalog.seed.json based on TMDB companies.
 *
 * Why: TMDB watch providers often lacks Disney Plus movie mapping in some regions.
 * This script infers Disney catalog movies from Disney-owned production companies.
 *
 * Usage:
 *   TMDB_API_KEY=... node tools/boost-disney-movies-inferred.mjs
 *
 * Optional:
 *   TARGET_INFERRED_DISNEY_MOVIES=200
 *   SEED_LANG=es-ES
 *   SEED_PROVIDERS_REGION=CO
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

const TARGET = Number(process.env.TARGET_INFERRED_DISNEY_MOVIES || '200');
const LANG = process.env.SEED_LANG || 'es-ES';
const REGION = String(process.env.SEED_PROVIDERS_REGION || 'CO').toUpperCase();

const COMPANY_NAMES = [
  'Walt Disney Pictures',
  'Pixar',
  'Marvel Studios',
  'Lucasfilm Ltd.',
  'Walt Disney Animation Studios',
  '20th Century Studios',
  'Searchlight Pictures'
];

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
  const year = Number(String(dateString || '').slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

async function searchCompanyId(name) {
  const url = new URL('https://api.themoviedb.org/3/search/company');
  url.searchParams.set('query', name);
  url.searchParams.set('page', '1');
  const payload = await tmdbJson(url.toString());
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const exact = rows.find((row) => String(row?.name || '').toLowerCase() === name.toLowerCase());
  const pick = exact || rows[0];
  return pick?.id ? Number(pick.id) : 0;
}

async function getGenreIndex() {
  const payload = await tmdbJson(`https://api.themoviedb.org/3/genre/movie/list?language=${encodeURIComponent(LANG)}`);
  const map = new Map();
  for (const g of payload.genres || []) map.set(Number(g.id), String(g.name || '').trim());
  return map;
}

async function discoverByCompany(companyId, genreIndex, perCompanyTarget) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 25 && out.length < perCompanyTarget; page++) {
    const url = new URL('https://api.themoviedb.org/3/discover/movie');
    url.searchParams.set('language', LANG);
    url.searchParams.set('sort_by', 'popularity.desc');
    url.searchParams.set('page', String(page));
    url.searchParams.set('with_companies', String(companyId));
    url.searchParams.set('include_adult', 'false');
    url.searchParams.set('include_video', 'false');
    url.searchParams.set('vote_count.gte', '20');
    const payload = await tmdbJson(url.toString());
    const rows = Array.isArray(payload?.results) ? payload.results : [];
    if (rows.length === 0) break;
    for (const item of rows) {
      const tmdbId = String(item?.id || '').trim();
      if (!tmdbId || seen.has(tmdbId)) continue;
      seen.add(tmdbId);
      out.push({
        type: 'movie',
        tmdbId,
        imdbId: null,
        title: String(item.title || '').trim(),
        year: pickYear(item.release_date),
        releaseDate: item.release_date || null,
        overview: String(item.overview || '').trim(),
        posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
        backdropUrl: item.backdrop_path ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}` : null,
        genres: (Array.isArray(item.genre_ids) ? item.genre_ids : []).map((id) => genreIndex.get(Number(id))).filter(Boolean),
        watchProviders: { region: REGION, flatrate: ['Disney Plus (inferred)'] }
      });
      if (out.length >= perCompanyTarget) break;
    }
    await sleep(80);
  }
  return out;
}

function mergeMovie(existing, incoming) {
  const prevProviders = Array.isArray(existing?.watchProviders?.flatrate) ? existing.watchProviders.flatrate : [];
  const nextProviders = Array.isArray(incoming?.watchProviders?.flatrate) ? incoming.watchProviders.flatrate : [];
  const providerSet = [...new Set([...prevProviders, ...nextProviders])];
  return {
    ...existing,
    ...incoming,
    imdbId: existing?.imdbId || incoming?.imdbId || null,
    title: existing?.title || incoming?.title || '',
    overview: existing?.overview || incoming?.overview || '',
    posterUrl: existing?.posterUrl || incoming?.posterUrl || null,
    backdropUrl: existing?.backdropUrl || incoming?.backdropUrl || null,
    genres: Array.isArray(existing?.genres) && existing.genres.length ? existing.genres : incoming.genres,
    watchProviders: {
      region: existing?.watchProviders?.region || incoming?.watchProviders?.region || REGION,
      flatrate: providerSet
    }
  };
}

function upsertMovies(seed, incoming) {
  const target = Array.isArray(seed.movies) ? seed.movies : [];
  let changed = 0;
  for (const movie of incoming) {
    const idx = target.findIndex((m) => String(m?.tmdbId || '') === String(movie.tmdbId));
    if (idx === -1) {
      target.push(movie);
      changed += 1;
      continue;
    }
    const merged = mergeMovie(target[idx], movie);
    if (JSON.stringify(merged) !== JSON.stringify(target[idx])) {
      target[idx] = merged;
      changed += 1;
    }
  }
  seed.movies = target;
  return changed;
}

function countDisneyMovies(seed) {
  return (seed.movies || []).filter((m) => {
    const names = Array.isArray(m?.watchProviders?.flatrate) ? m.watchProviders.flatrate : [];
    return names.some((name) => String(name || '').toLowerCase().includes('disney'));
  }).length;
}

async function main() {
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  seed.movies = Array.isArray(seed.movies) ? seed.movies : [];
  seed.series = Array.isArray(seed.series) ? seed.series : [];

  const genreIndex = await getGenreIndex();
  const companyIds = [];
  for (const name of COMPANY_NAMES) {
    const id = await searchCompanyId(name);
    if (id) companyIds.push({ id, name });
    await sleep(80);
  }
  if (companyIds.length === 0) throw new Error('No Disney-related company ids resolved from TMDB');

  const perCompanyTarget = Math.max(15, Math.ceil(TARGET / companyIds.length));
  const collected = [];
  for (const company of companyIds) {
    const items = await discoverByCompany(company.id, genreIndex, perCompanyTarget);
    collected.push(...items);
    console.log(`[disney-inferred] ${company.name}(${company.id}) -> ${items.length}`);
  }

  const deduped = [];
  const seen = new Set();
  for (const item of collected) {
    const key = String(item.tmdbId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  deduped.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
  const selected = deduped.slice(0, TARGET);
  const changed = upsertMovies(seed, selected);

  seed.version = Number(seed.version || 1) + 1;
  seed.generatedAt = new Date().toISOString();
  seed.source = {
    ...(seed.source || {}),
    inferredDisneyMovies: {
      target: TARGET,
      region: REGION,
      companies: companyIds,
      updatedAt: seed.generatedAt
    }
  };

  fs.writeFileSync(SEED_PATH, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  console.log(`[disney-inferred] changed=${changed} disneyMovies=${countDisneyMovies(seed)}`);
}

await main();
