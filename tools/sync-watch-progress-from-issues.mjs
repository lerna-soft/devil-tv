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
const MAX_ISSUES = Math.max(0, Number(process.env.WATCH_PROGRESS_MAX_ISSUES || '0'));

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
  const eventIssue = await loadEventIssue();
  let issues = eventIssue ? [eventIssue] : await fetchAllIssues();
  issues = [...issues].sort((a, b) => {
    const at = Date.parse(a?.created_at || a?.updated_at || 0) || 0;
    const bt = Date.parse(b?.created_at || b?.updated_at || 0) || 0;
    return at - bt;
  });
  if (MAX_ISSUES > 0) issues = issues.slice(0, MAX_ISSUES);
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

  return { users: dedupeUsers(users), processedIssues: dedupeIssues(processedIssues) };
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
  if (!/WATCH_PROGRESS_SYNC_REQUEST/i.test(body)) return null;
  const email = normalizeEmail((body.match(/^Email:\s*(.+)$/im) || [])[1]);
  const name = String((body.match(/^Name:\s*(.+)$/im) || [])[1] || '').trim();
  const imdbId = String((body.match(/^IMDb:\s*(tt\d+)$/im) || [])[1] || '').trim();
  const tmdbId = String((body.match(/^TMDB:\s*(\d+)$/im) || [])[1] || '').trim();
  const season = positiveInteger((body.match(/^Season:\s*(\d+)$/im) || [])[1], 1);
  const episode = positiveInteger((body.match(/^Episode:\s*(\d+)$/im) || [])[1], 1);
  const progress = Number((body.match(/^Progress:\s*([0-9]+(?:\.[0-9]+)?)$/im) || [])[1] || 0);
  const title = String((body.match(/^Title:\s*(.+)$/im) || [])[1] || '').trim();
  const type = String((body.match(/^Type:\s*(.+)$/im) || [])[1] || '').trim().toLowerCase();
  const playerStatus = String((body.match(/^PlayerStatus:\s*(.+)$/im) || [])[1] || '').trim().toLowerCase();
  if (!email || (!imdbId && !tmdbId)) return null;
  return {
    email,
    name,
    imdbId,
    tmdbId,
    season,
    episode,
    progress,
    title,
    type,
    playerStatus,
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

function dedupeIssues(issues) {
  const map = new Map();
  for (const issue of issues || []) {
    if (!issue?.number) continue;
    map.set(issue.number, issue);
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
    const existingRaw = await fs.readFile(filePath, 'utf8').catch(() => '');
    const existing = existingRaw.trim() ? safeJson(existingRaw) : {};
    const existingProgress = existing?.progress && typeof existing.progress === 'object' ? existing.progress : {};
    const key = user.imdbId || user.tmdbId;
    const previous = existingProgress[key] && typeof existingProgress[key] === 'object' ? existingProgress[key] : {};
    const mergedProgress = {
      ...existingProgress,
      [key]: {
        ...previous,
        imdbId: user.imdbId,
        tmdbId: user.tmdbId,
        lastSeason: user.season,
        lastEpisode: user.episode,
        progress: user.progress,
        lastProgress: user.progress,
        updatedAt: user.updatedAt,
        watched: { ...(previous.watched || {}) }
      }
    };
    const historyEntry = {
      imdbId: user.imdbId,
      tmdbId: user.tmdbId,
      title: user.title || '',
      type: user.type || '',
      season: user.season,
      episode: user.episode,
      progress: user.progress,
      playerStatus: user.playerStatus || 'playing',
      updatedAt: user.updatedAt
    };
    const history = mergeHistory(existing?.history || [], [historyEntry]);
    const payload = {
      email: user.email,
      name: user.name || existing?.name || '',
      updatedAt: maxIsoString(existing?.updatedAt, user.updatedAt),
      progress: mergedProgress,
      lastWatch: pickNewestByUpdatedAt(existing?.lastWatch, {
        imdbId: user.imdbId,
        tmdbId: user.tmdbId,
        season: user.season,
        episode: user.episode,
        progress: user.progress,
        updatedAt: user.updatedAt
      }),
      lastSelection: existing?.lastSelection || null,
      history
    };
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`[watch-progress] wrote ${filePath}`);
  }
}

function safeJson(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function maxIsoString(a, b) {
  const at = Date.parse(a || 0) || 0;
  const bt = Date.parse(b || 0) || 0;
  return bt >= at ? (b || a || '') : (a || b || '');
}

function pickNewestByUpdatedAt(existing, incoming) {
  if (!existing) return incoming || null;
  if (!incoming) return existing || null;
  const existingUpdated = Date.parse(existing.updatedAt || 0) || 0;
  const incomingUpdated = Date.parse(incoming.updatedAt || 0) || 0;
  return incomingUpdated >= existingUpdated ? incoming : existing;
}

function mergeHistory(existing, incoming) {
  const rows = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]
    .filter((entry) => entry && typeof entry === 'object');
  const map = new Map();
  for (const row of rows) {
    const id = String(row.imdbId || row.tmdbId || '').trim();
    const season = positiveInteger(row.season, 1);
    const episode = positiveInteger(row.episode, 1);
    const status = String(row.playerStatus || '').trim().toLowerCase() || 'playing';
    const at = String(row.updatedAt || '').trim();
    const key = `${id}:${season}x${episode}:${status}:${at}`;
    if (!id || !at) continue;
    map.set(key, {
      imdbId: String(row.imdbId || '').trim(),
      tmdbId: String(row.tmdbId || '').trim(),
      title: String(row.title || '').trim(),
      type: String(row.type || '').trim(),
      season,
      episode,
      progress: Number(row.progress || 0),
      playerStatus: status,
      updatedAt: at
    });
  }
  return [...map.values()]
    .sort((a, b) => (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0))
    .slice(0, 500);
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
        console.warn(`[watch-progress] skip close issue #${issue.number}: ${response.status}`);
        continue;
      }
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
