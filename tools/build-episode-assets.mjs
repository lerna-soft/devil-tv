#!/usr/bin/env node
/**
 * Builds static episode assets for selected series.
 *
 * Output:
 *   assets/episodes/index.json
 *   assets/episodes/<imdbId>.txt
 *
 * Source:
 *   TVMaze public API, resolved from IMDb ID or title.
 *
 * Usage:
 *   node tools/build-episode-assets.mjs
 *   node tools/build-episode-assets.mjs tt0367409 tt0805669
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'assets', 'episodes');
const TARGETS_PATH = path.join(OUT_DIR, 'targets.json');
const MANIFEST_PATH = path.join(OUT_DIR, 'index.json');

async function main() {
  const targets = await loadTargets(process.argv.slice(2));
  if (targets.length === 0) {
    throw new Error('No episode targets provided.');
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      provider: 'tvmaze',
      strategy: 'lookup_by_imdb_then_title'
    },
    series: {}
  };

  const skipped = [];
  const enrichedTargets = [];
  for (const target of targets) {
    try {
      const resolved = await resolveShow(target);
      const episodes = await fetchEpisodes(resolved.tvmazeId);
      const lines = episodes
        .map((episode) => `tt${String(target.imdbId).replace(/^tt/i, '')}_${episode.season}x${episode.episode}`)
        .join('\n');
      await fs.writeFile(path.join(OUT_DIR, `${target.imdbId}.txt`), `${lines}\n`, 'utf8');
      const normalizedTarget = {
        imdbId: target.imdbId,
        title: resolved.name || target.title || target.imdbId,
        posterUrl: resolved.posterUrl || String(target.posterUrl || '').trim()
      };
      enrichedTargets.push(normalizedTarget);
      manifest.series[target.imdbId] = {
        title: resolved.name,
        tvmazeId: resolved.tvmazeId,
        posterUrl: resolved.posterUrl || '',
        file: `${target.imdbId}.txt`,
        seasonCount: new Set(episodes.map((episode) => episode.season)).size,
        episodeCount: episodes.length
      };
    } catch (error) {
      skipped.push({ imdbId: target.imdbId, reason: error?.message || String(error) });
      console.warn(`[episode-assets] skipped ${target.imdbId}: ${error?.message || error}`);
    }
  }

  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (enrichedTargets.length > 0) {
    await fs.writeFile(TARGETS_PATH, `${JSON.stringify({ series: enrichedTargets }, null, 2)}\n`, 'utf8');
    console.log(`Updated ${TARGETS_PATH}`);
  }
  console.log(`Wrote ${MANIFEST_PATH}`);
  console.log(`Series: ${Object.keys(manifest.series).length}`);
  if (skipped.length > 0) {
    console.log(`Skipped: ${skipped.length}`);
  }
}

async function loadTargets(cliIds) {
  const cli = cliIds.map((id) => String(id || '').trim()).filter(Boolean);
  if (cli.length > 0) {
    return cli.map((imdbId) => ({ imdbId }));
  }

  const raw = await fs.readFile(TARGETS_PATH, 'utf8').catch(() => '');
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.series) ? parsed.series : [];
  return entries
    .map((entry) => {
      if (typeof entry === 'string') return { imdbId: entry.trim() };
      if (!entry || typeof entry !== 'object') return null;
      const imdbId = String(entry.imdbId || '').trim();
      const title = String(entry.title || '').trim();
      const posterUrl = String(entry.posterUrl || '').trim();
      return imdbId ? { imdbId, title, posterUrl } : null;
    })
    .filter(Boolean);
}

async function resolveShow(target) {
  const imdbId = String(target.imdbId || '').trim();
  if (!imdbId) throw new Error('Missing IMDb ID.');

  try {
    const show = await tvmazeJson(`/lookup/shows?imdb=${encodeURIComponent(imdbId)}`);
    return {
      tvmazeId: show.id,
      name: show.name || target.title || imdbId,
      posterUrl: pickPosterUrl(show, target)
    };
  } catch {
    if (!target.title) throw new Error(`TVMaze lookup failed for ${imdbId}.`);
  }

  const query = encodeURIComponent(target.title);
  const results = await tvmazeJson(`/search/shows?q=${query}`);
  const pick = results.find((item) => String(item?.show?.name || '').trim().toLowerCase() === target.title.toLowerCase()) || results[0];
  if (!pick?.show?.id) throw new Error(`TVMaze title search failed for ${imdbId}.`);
  return {
    tvmazeId: pick.show.id,
    name: pick.show.name || target.title || imdbId,
    posterUrl: pickPosterUrl(pick.show, target)
  };
}

function pickPosterUrl(show, target = {}) {
  const fromTvmaze = String(show?.image?.original || show?.image?.medium || '').trim();
  if (fromTvmaze) return fromTvmaze;
  return String(target?.posterUrl || '').trim();
}

async function fetchEpisodes(tvmazeId) {
  const episodes = await tvmazeJson(`/shows/${encodeURIComponent(tvmazeId)}/episodes`);
  return (Array.isArray(episodes) ? episodes : [])
    .filter((episode) => Number.isInteger(episode?.season) && Number.isInteger(episode?.number) && episode.season > 0 && episode.number > 0)
    .sort((a, b) => (a.season - b.season) || (a.number - b.number))
    .map((episode) => ({
      season: episode.season,
      episode: episode.number
    }));
}

async function tvmazeJson(pathname) {
  const url = `https://api.tvmaze.com${pathname}`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json'
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`TVMaze ${response.status} ${response.statusText} for ${url}\n${text}`.trim());
  }
  return response.json();
}

await main();
