#!/usr/bin/env node
/**
 * Sync catalog seed entries from GitHub issues into assets/catalog.seed.json.
 *
 * Issues labeled `catalog-seed-sync` must include:
 * CATALOG_SEED_SYNC_REQUEST
 * Type: movie|series
 * IMDb: tt...
 * TMDB: 12345
 * Title: ...
 * Year: ...
 * PosterUrl: ...
 * Description: ...
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SEED_PATH = path.join(PROJECT_ROOT, 'assets', 'catalog.seed.json');
const OWNER_REPO = String(process.env.GITHUB_REPOSITORY || '').trim();
const TOKEN = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
const LABEL = 'catalog-seed-sync';
const REPORT_PATH = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'mep-catalog-seed-report.json');

function sanitizePosterUrl(value) {
  const poster = String(value || '').trim();
  if (!poster) return '';
  if (!/^https?:\/\//i.test(poster)) return '';
  if (/^description\s*:/i.test(poster)) return '';
  return poster;
}

async function main() {
  if (!OWNER_REPO) {
    console.log('[catalog-seed] skip: missing GITHUB_REPOSITORY');
    return;
  }
  if (!TOKEN) {
    console.log('[catalog-seed] skip: missing GITHUB_TOKEN/GH_TOKEN');
    return;
  }

  const seed = await loadSeed();
  const eventIssue = await loadEventIssue();
  const issues = eventIssue ? [eventIssue] : await fetchAllIssues();
  const requests = [];
  const processedIssues = [];

  for (const issue of issues) {
    const req = parseIssue(issue);
    if (!req) continue;
    requests.push(req);
    processedIssues.push({
      number: issue.number,
      htmlUrl: issue.html_url,
      type: req.type,
      imdbId: req.imdbId,
      tmdbId: req.tmdbId,
      title: req.title
    });
  }

  const deduped = dedupeRequests(requests);
  let changed = false;
  for (const req of deduped) {
    changed = upsertSeedEntry(seed, req) || changed;
  }

  if (changed) {
    seed.version = Number(seed.version || 1) + 1;
    seed.generatedAt = new Date().toISOString();
    await fs.writeFile(SEED_PATH, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
    console.log(`[catalog-seed] wrote ${SEED_PATH}`);
  } else {
    console.log('[catalog-seed] no seed changes');
  }

  await closeProcessedIssues(processedIssues);
  await writeReport(processedIssues);
  console.log(`[catalog-seed] processed issues: ${processedIssues.length}`);
}

async function loadSeed() {
  const raw = await fs.readFile(SEED_PATH, 'utf8').catch(() => '');
  if (!raw.trim()) {
    return { version: 1, generatedAt: new Date().toISOString(), source: { provider: 'tmdb' }, movies: [], series: [] };
  }
  const parsed = JSON.parse(raw);
  parsed.movies = Array.isArray(parsed.movies) ? parsed.movies : [];
  parsed.series = Array.isArray(parsed.series) ? parsed.series : [];
  return parsed;
}

async function loadEventIssue() {
  const eventPath = String(process.env.GITHUB_EVENT_PATH || '').trim();
  if (!eventPath) return null;
  const raw = await fs.readFile(eventPath, 'utf8').catch(() => '');
  if (!raw.trim()) return null;
  const event = JSON.parse(raw);
  const issue = event?.issue;
  if (!issue || issue.pull_request) return null;
  const labels = Array.isArray(issue.labels) ? issue.labels.map((label) => String(label?.name || '').trim()) : [];
  if (!labels.includes(LABEL)) return null;
  return issue;
}

function parseIssue(issue) {
  const body = String(issue?.body || '');
  if (!/CATALOG_SEED_SYNC_REQUEST/i.test(body)) return null;
  const typeRaw = String((body.match(/^Type:\s*(.+)$/im) || [])[1] || '').trim().toLowerCase();
  const type = typeRaw === 'movie' ? 'movie' : typeRaw === 'series' ? 'series' : '';
  const imdbId = String((body.match(/^IMDb:\s*(tt\d+)$/im) || [])[1] || '').trim();
  const tmdbId = String((body.match(/^TMDB:\s*(\d+)$/im) || [])[1] || '').trim();
  const title = String((body.match(/^Title:\s*(.+)$/im) || [])[1] || '').trim();
  const year = Number((body.match(/^Year:\s*(\d{4})$/im) || [])[1] || 0) || null;
  const posterUrl = sanitizePosterUrl((body.match(/^PosterUrl:\s*(.+)$/im) || [])[1] || '');
  const description = String((body.match(/^Description:\s*(.*)$/im) || [])[1] || '').trim();
  if (!type || (!imdbId && !tmdbId) || !title) return null;
  return { type, imdbId, tmdbId, title, year, posterUrl, description, updatedAt: parseIssueDate(issue) };
}

async function fetchAllIssues() {
  const out = [];
  let page = 1;
  while (page <= 10) {
    const url = new URL(`https://api.github.com/repos/${OWNER_REPO}/issues`);
    url.searchParams.set('state', 'open');
    url.searchParams.set('labels', LABEL);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));

    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${TOKEN}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'media-evaluation-platform-static'
      }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GitHub issues API ${response.status} ${response.statusText}\n${text}`.trim());
    }
    const issues = await response.json();
    const items = Array.isArray(issues) ? issues : [];
    out.push(...items.filter((item) => !item.pull_request));
    if (items.length < 100) break;
    page += 1;
  }
  return out;
}

function dedupeRequests(requests) {
  const map = new Map();
  for (const req of requests) {
    const key = `${req.type}:${req.imdbId || req.tmdbId}`;
    const existing = map.get(key);
    if (!existing || Date.parse(req.updatedAt || 0) >= Date.parse(existing.updatedAt || 0)) {
      map.set(key, req);
    }
  }
  return [...map.values()];
}

function upsertSeedEntry(seed, req) {
  const target = req.type === 'movie' ? seed.movies : seed.series;
  const index = target.findIndex((entry) =>
    (req.imdbId && String(entry?.imdbId || '').trim() === req.imdbId)
    || (req.tmdbId && String(entry?.tmdbId || '').trim() === req.tmdbId)
  );

  const payload = {
    type: req.type,
    tmdbId: req.tmdbId || null,
    imdbId: req.imdbId || null,
    title: req.title,
    year: req.year,
    releaseDate: null,
    overview: req.description || '',
    posterUrl: sanitizePosterUrl(req.posterUrl) || null,
    backdropUrl: null,
    genres: [],
    watchProviders: { region: 'CO', flatrate: [] }
  };

  if (index === -1) {
    target.push(payload);
    return true;
  }

  const existing = target[index] || {};
  const merged = {
    ...existing,
    ...payload,
    tmdbId: existing.tmdbId || payload.tmdbId,
    imdbId: existing.imdbId || payload.imdbId,
    title: existing.title || payload.title,
    year: existing.year || payload.year,
    releaseDate: existing.releaseDate || payload.releaseDate,
    overview: existing.overview || payload.overview,
    posterUrl: sanitizePosterUrl(existing.posterUrl) || sanitizePosterUrl(payload.posterUrl) || null,
    backdropUrl: existing.backdropUrl || payload.backdropUrl,
    genres: Array.isArray(existing.genres) && existing.genres.length ? existing.genres : payload.genres,
    watchProviders: existing.watchProviders || payload.watchProviders
  };
  const before = JSON.stringify(existing);
  const after = JSON.stringify(merged);
  if (before === after) return false;
  target[index] = merged;
  return true;
}

async function closeProcessedIssues(processedIssues) {
  for (const issue of processedIssues) {
    const url = `https://api.github.com/repos/${OWNER_REPO}/issues/${issue.number}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'media-evaluation-platform-static'
      },
      body: JSON.stringify({ state: 'closed' })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if ([404, 410, 422].includes(response.status)) {
        console.warn(`[catalog-seed] skip close issue #${issue.number}: ${response.status}`);
        continue;
      }
      throw new Error(`Failed to close issue #${issue.number} (${response.status} ${response.statusText})\n${text}`.trim());
    }
    console.log(`[catalog-seed] closed issue #${issue.number}`);
  }
}

async function writeReport(processedIssues) {
  const payload = { generatedAt: new Date().toISOString(), processedIssues };
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parseIssueDate(issue) {
  return String(issue?.updated_at || issue?.created_at || new Date().toISOString());
}

await main();
