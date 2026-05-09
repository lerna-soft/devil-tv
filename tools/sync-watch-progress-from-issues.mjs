#!/usr/bin/env node
/**
 * Sync watch progress from GitHub issues into assets/watch-progress/.
 *
 * Issues labeled `watch-progress-sync` must include:
 * WATCH_PROGRESS_SYNC_REQUEST
 * Email: ...
 * Name: ...
 * IMDb: ...
 * TMDB: ...
 * Season: ...
 * Episode: ...
 * Progress: ...
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORE_DIR = path.join(PROJECT_ROOT, 'assets', 'watch-progress');
const INDEX_PATH = path.join(STORE_DIR, 'index.json');
const OWNER_REPO = String(process.env.GITHUB_REPOSITORY || '').trim();
const TOKEN = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
const LABEL = 'watch-progress-sync';
const REPORT_PATH = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'mep-watch-progress-report.json');

async function main() {
  if (!OWNER_REPO) {
    console.log('[watch-progress] skip: missing GITHUB_REPOSITORY');
    return;
  }
  if (!TOKEN) {
    console.log('[watch-progress] skip: missing GITHUB_TOKEN/GH_TOKEN');
    return;
  }

  await fs.mkdir(STORE_DIR, { recursive: true });
  const existingIndex = await loadIndex();
  const { users, processedIssues } = await loadUsersFromIssues(existingIndex);
  const mergedIndex = mergeIndex(existingIndex, users);

  await fs.writeFile(INDEX_PATH, `${JSON.stringify({ users: mergedIndex }, null, 2)}\n`, 'utf8');
  await writeUserFiles(users);
  await closeProcessedIssues(processedIssues);
  await writeReport(processedIssues);
  console.log(`[watch-progress] wrote ${INDEX_PATH}`);
  console.log(`[watch-progress] users: ${mergedIndex.length}`);
}

async function loadIndex() {
  const raw = await fs.readFile(INDEX_PATH, 'utf8').catch(() => '');
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed?.users) ? parsed.users.map(normalizeIndexEntry).filter(Boolean) : [];
}

function normalizeIndexEntry(entry) {
  const email = normalizeEmail(entry?.email);
  if (!email) return null;
  return { email, file: String(entry?.file || `${email}.json`).trim() };
}

async function loadUsersFromIssues(existingIndex) {
  const issues = await fetchAllIssues();
  const users = [];
  const processedIssues = [];
  for (const issue of issues) {
    const progress = parseIssue(issue);
    if (!progress) continue;
    const file = `${progress.email}.json`;
    users.push({ ...progress, file });
    processedIssues.push({
      number: issue.number,
      htmlUrl: issue.html_url,
      email: progress.email,
      imdbId: progress.imdbId,
      season: progress.season,
      episode: progress.episode,
      progress: progress.progress
    });
  }

  for (const user of users) {
    const existing = existingIndex.find((entry) => entry.email === user.email);
    if (existing) user.file = existing.file || user.file;
  }

  return { users: dedupeUsers(users), processedIssues };
}

function parseIssue(issue) {
  const body = String(issue?.body || '');
  if (!/WATCH_PROGRESS_SYNC_REQUEST/i.test(body)) return null;
  const email = normalizeEmail((body.match(/^Email:\s*(.+)$/im) || [])[1]);
  const name = String((body.match(/^Name:\s*(.+)$/im) || [])[1] || '').trim();
  const imdbId = String((body.match(/^IMDb:\s*(tt\d+)$/im) || [])[1] || '').trim();
  const tmdbId = String((body.match(/^TMDB:\s*(\d+)$/im) || [])[1] || '').trim();
  const season = positiveInteger((body.match(/^Season:\s*(\d+)$/im) || [])[1], 1);
  const episode = positiveInteger((body.match(/^Episode:\s*(\d+)$/im) || [])[1], 1);
  const progress = Number((body.match(/^Progress:\s*([0-9]+(?:\.[0-9]+)?)$/im) || [])[1] || 0);
  if (!email || (!imdbId && !tmdbId)) return null;
  return {
    email,
    name,
    imdbId,
    tmdbId,
    season,
    episode,
    progress,
    updatedAt: parseIssueDate(issue),
    progressKey: `${imdbId || tmdbId}:${season}x${episode}`
  };
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

function dedupeUsers(users) {
  const map = new Map();
  for (const user of users) {
    const key = `${user.email}:${user.progressKey}`;
    const existing = map.get(key);
    if (!existing || Date.parse(user.updatedAt || 0) >= Date.parse(existing.updatedAt || 0)) {
      map.set(key, user);
    }
  }
  return [...map.values()];
}

function mergeIndex(existing, incoming) {
  const map = new Map(existing.map((entry) => [entry.email, entry]));
  for (const user of incoming) map.set(user.email, { email: user.email, file: user.file || `${user.email}.json` });
  return [...map.values()].sort((a, b) => a.email.localeCompare(b.email, 'es', { sensitivity: 'base' }));
}

async function writeUserFiles(users) {
  for (const user of users) {
    const filePath = path.join(STORE_DIR, user.file || `${user.email}.json`);
    const payload = {
      email: user.email,
      name: user.name,
      updatedAt: user.updatedAt,
      progress: {
        [user.imdbId || user.tmdbId]: {
          imdbId: user.imdbId,
          tmdbId: user.tmdbId,
          lastSeason: user.season,
          lastEpisode: user.episode,
          progress: user.progress,
          updatedAt: user.updatedAt,
          watched: {}
        }
      },
      lastWatch: {
        imdbId: user.imdbId,
        tmdbId: user.tmdbId,
        season: user.season,
        episode: user.episode,
        progress: user.progress,
        updatedAt: user.updatedAt
      }
    };
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`[watch-progress] wrote ${filePath}`);
  }
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
      throw new Error(`Failed to close issue #${issue.number} (${response.status} ${response.statusText})\n${text}`.trim());
    }
    console.log(`[watch-progress] closed issue #${issue.number}`);
  }
}

async function writeReport(processedIssues) {
  const payload = {
    generatedAt: new Date().toISOString(),
    repository: OWNER_REPO,
    label: LABEL,
    processedIssues: processedIssues || []
  };
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[watch-progress] report: ${REPORT_PATH}`);
}

function parseIssueDate(issue) {
  return String(issue?.updated_at || issue?.closed_at || new Date().toISOString());
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

await main();
