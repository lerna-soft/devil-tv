#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SEED_PATH = path.join(PROJECT_ROOT, 'assets', 'catalog.seed.json');

const TMDB_READ_TOKEN_SEED = 'mep_tmdb_token_key_v1';
const TMDB_READ_TOKEN_CIPHER = 'CBw6NxYqBwsQHSUiMBQWWisQFU8fCBw6NxA6NQsQHSUCPzo0EiouFR1+OiMaEhkoVTsIJRgmMSw3MTE/MzsDIwg9bSVZKggWRCICLB0WBlAQBR94WygkPEciICcmOysiVSA2X1c2GydCJAs+bi0ELVQWHjZePwMSEystPERoOScbETMgHDsIPgcxDyg2JiI0JzhIJBY5MToHBlEdGAwSLFgIEi8RPDFdCwYdCRw3Jyg7OCwhVzQHIR8YCE9EJA8fJxI8SiU4GSUbXCI9XiEobwxEGVAZLBcHAFppBAAsMDkRBFxACB1mOBEkGTECICc=';

function decodeIssueToken(cipherText, seed) {
  const encoded = String(cipherText || '').trim();
  const key = String(seed || '').trim();
  if (!encoded || !key) return '';
  const bytes = Buffer.from(encoded, 'base64');
  const out = [];
  for (let i = 0; i < bytes.length; i += 1) {
    out.push(String.fromCharCode(bytes[i] ^ key.charCodeAt(i % key.length)));
  }
  return out.join('').trim();
}

function sanitizePosterUrl(value) {
  const poster = String(value || '').trim();
  if (!poster) return '';
  if (!/^https?:\/\//i.test(poster)) return '';
  if (/^description\s*:/i.test(poster)) return '';
  return poster;
}

async function tmdbFetchJson(pathname, params = {}) {
  const token = decodeIssueToken(TMDB_READ_TOKEN_CIPHER, TMDB_READ_TOKEN_SEED);
  if (!token) throw new Error('Missing TMDB token');
  const url = new URL(`https://api.themoviedb.org/3${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`TMDB ${response.status} ${response.statusText} for ${url}\n${text}`.trim());
  }
  return response.json();
}

function pickPosterUrlFromTmdb(payload) {
  return payload?.poster_path ? `https://image.tmdb.org/t/p/w500${payload.poster_path}` : '';
}

async function resolvePoster(entry) {
  const type = entry.type === 'series' ? 'tv' : 'movie';
  const tmdbId = String(entry.tmdbId || '').trim();
  const imdbId = String(entry.imdbId || '').trim();
  const title = String(entry.title || '').trim();

  if (tmdbId) {
    const details = await tmdbFetchJson(`/${type}/${encodeURIComponent(tmdbId)}`, { language: 'es-ES' }).catch(() => null);
    const poster = sanitizePosterUrl(pickPosterUrlFromTmdb(details));
    if (poster) return { tmdbId, posterUrl: poster };
  }

  if (imdbId) {
    const found = await tmdbFetchJson(`/find/${encodeURIComponent(imdbId)}`, { external_source: 'imdb_id', language: 'es-ES' }).catch(() => null);
    const pick = type === 'tv' ? (found?.tv_results?.[0] || null) : (found?.movie_results?.[0] || null);
    const poster = sanitizePosterUrl(pickPosterUrlFromTmdb(pick));
    if (poster) return { tmdbId: pick?.id ? String(pick.id) : tmdbId, posterUrl: poster };
  }

  if (title) {
    const searchPath = type === 'tv' ? '/search/tv' : '/search/movie';
    const search = await tmdbFetchJson(searchPath, { query: title, language: 'es-ES', include_adult: 'false' }).catch(() => null);
    const candidates = Array.isArray(search?.results) ? search.results : [];
    const exact = candidates.find((item) => String(item?.name || item?.title || '').trim().toLowerCase() === title.toLowerCase());
    const pick = exact || candidates[0] || null;
    const poster = sanitizePosterUrl(pickPosterUrlFromTmdb(pick));
    if (poster) return { tmdbId: pick?.id ? String(pick.id) : tmdbId, posterUrl: poster };
  }

  return null;
}

async function main() {
  const raw = await fs.readFile(SEED_PATH, 'utf8');
  const seed = JSON.parse(raw);
  const buckets = ['movies', 'series'];
  let changed = 0;
  let candidates = 0;

  for (const bucket of buckets) {
    const rows = Array.isArray(seed[bucket]) ? seed[bucket] : [];
    for (const entry of rows) {
      const currentPoster = sanitizePosterUrl(entry.posterUrl);
      if (currentPoster) {
        entry.posterUrl = currentPoster;
        continue;
      }
      candidates += 1;
      const resolved = await resolvePoster(entry).catch(() => null);
      if (!resolved?.posterUrl) {
        entry.posterUrl = null;
        continue;
      }
      entry.posterUrl = resolved.posterUrl;
      if (!entry.tmdbId && resolved.tmdbId) entry.tmdbId = resolved.tmdbId;
      changed += 1;
    }
  }

  seed.generatedAt = new Date().toISOString();
  await fs.writeFile(SEED_PATH, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  console.log(`Repaired posters: ${changed}`);
  console.log(`Candidates checked: ${candidates}`);
}

await main();
