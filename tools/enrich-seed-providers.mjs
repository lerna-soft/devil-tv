#!/usr/bin/env node
/**
 * Enriches assets/catalog.seed.json with TMDB watch providers per title.
 *
 * Usage:
 *   TMDB_API_KEY=... node tools/enrich-seed-providers.mjs
 *
 * Optional:
 *   SEED_PROVIDERS_REGION=CO
 *   SEED_INPUT=assets/catalog.seed.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
if (!TMDB_API_KEY) {
  console.error('Missing TMDB_API_KEY. Example: TMDB_API_KEY=... node tools/enrich-seed-providers.mjs');
  process.exit(2);
}

const REGION = String(process.env.SEED_PROVIDERS_REGION || 'CO').toUpperCase();
const INPUT_PATH = path.resolve(PROJECT_ROOT, process.env.SEED_INPUT || 'assets/catalog.seed.json');

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

async function fetchProviders(kind, tmdbId) {
  const url = kind === 'movie'
    ? `https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}/watch/providers`
    : `https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}/watch/providers`;
  const payload = await tmdbJson(url);
  const regionPayload = payload?.results?.[REGION] || null;
  const flatrate = Array.isArray(regionPayload?.flatrate)
    ? regionPayload.flatrate.map((entry) => entry?.provider_name).filter(Boolean)
    : [];
  return { region: REGION, flatrate };
}

function needsProviders(entry) {
  const hasRegion = String(entry?.watchProviders?.region || '').trim();
  const hasFlatrate = Array.isArray(entry?.watchProviders?.flatrate);
  return !hasRegion || !hasFlatrate;
}

async function main() {
  const raw = fs.readFileSync(INPUT_PATH, 'utf8');
  const seed = JSON.parse(raw);
  const movies = Array.isArray(seed?.movies) ? seed.movies : [];
  const series = Array.isArray(seed?.series) ? seed.series : [];

  const jobs = [
    ...movies.map((entry) => ({ entry, kind: 'movie' })),
    ...series.map((entry) => ({ entry, kind: 'tv' }))
  ].filter(({ entry }) => entry?.tmdbId && needsProviders(entry));

  console.log(`Enriching providers in ${INPUT_PATH}`);
  console.log(`Region=${REGION}. Pending titles=${jobs.length}`);

  let done = 0;
  for (const job of jobs) {
    try {
      job.entry.watchProviders = await fetchProviders(job.kind === 'movie' ? 'movie' : 'tv', job.entry.tmdbId);
    } catch {
      job.entry.watchProviders = { region: REGION, flatrate: [] };
    }
    done += 1;
    if (done % 50 === 0 || done === jobs.length) {
      console.log(`Progress: ${done}/${jobs.length}`);
    }
    await sleep(60);
  }

  seed.version = Number(seed.version || 1) + 1;
  seed.generatedAt = new Date().toISOString();
  seed.source = {
    ...(seed.source || {}),
    providersRegion: REGION,
    providersEnrichedAt: seed.generatedAt
  };

  fs.writeFileSync(INPUT_PATH, JSON.stringify(seed, null, 2));
  console.log(`Updated ${INPUT_PATH} (version=${seed.version})`);
}

await main();
