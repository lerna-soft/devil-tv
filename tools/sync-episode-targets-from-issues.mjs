#!/usr/bin/env node
/**
 * Sync episode targets from GitHub issues into assets/episodes/targets.json.
 *
 * This script is intended for CI. It reads open issues tagged with `episode-sync`,
 * extracts IMDb IDs from the issue body, and merges them into the episode target list.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TARGETS_PATH = path.join(PROJECT_ROOT, 'assets', 'episodes', 'targets.json');
const OWNER_REPO = String(process.env.GITHUB_REPOSITORY || '').trim();
const TOKEN = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
const LABEL = 'episode-sync';
const REPORT_PATH = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'mep-episode-sync-report.json');

async function main() {
  if (!OWNER_REPO) {
    console.log('[episode-sync] skip: missing GITHUB_REPOSITORY');
    return;
  }

  if (!TOKEN) {
    console.log('[episode-sync] skip: missing GITHUB_TOKEN/GH_TOKEN');
    return;
  }

  const existing = await loadTargets();
  const { targets: fromIssues, processedIssues } = await loadTargetsFromIssues();
  const merged = mergeTargets(existing, fromIssues);

  if (sameTargets(existing, merged)) {
    console.log('[episode-sync] no target changes');
    await writeReport(processedIssues);
    return;
  }

  await fs.writeFile(TARGETS_PATH, `${JSON.stringify({ series: merged }, null, 2)}\n`, 'utf8');
  await writeReport(processedIssues);
  console.log(`[episode-sync] wrote ${TARGETS_PATH}`);
  console.log(`[episode-sync] targets: ${merged.length}`);
}

async function loadTargets() {
  const raw = await fs.readFile(TARGETS_PATH, 'utf8').catch(() => '');
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed?.series) ? parsed.series : [];
  return normalizeTargets(entries);
}

async function loadTargetsFromIssues() {
  const issues = await fetchAllIssues();
  const targets = [];
  const processedIssues = [];
  for (const issue of issues) {
    const target = parseIssue(issue);
    if (target) {
      targets.push(target);
      processedIssues.push({
        number: issue.number,
        htmlUrl: issue.html_url,
        imdbId: target.imdbId,
        title: target.title
      });
    }
  }
  return { targets: normalizeTargets(targets), processedIssues };
}

function parseIssue(issue) {
  const body = String(issue?.body || '');
  if (!/Chapters listed in app:\s*no/i.test(body)) return null;
  if (!/IMDb:\s*tt\d+/i.test(body)) return null;

  const imdbId = (body.match(/IMDb:\s*(tt\d+)/i) || [])[1];
  const title = (body.match(/^Title:\s*(.+)$/im) || [])[1] || issue?.title || imdbId;
  if (!imdbId) return null;
  return {
    imdbId: imdbId.trim(),
    title: String(title || imdbId).trim()
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
    const pageItems = items.filter((item) => !item.pull_request);
    out.push(...pageItems);
    if (items.length < 100) break;
    page += 1;
  }
  return out;
}

function normalizeTargets(entries) {
  const map = new Map();
  for (const entry of entries) {
    const imdbId = String(entry?.imdbId || '').trim();
    if (!/^tt\d+$/i.test(imdbId)) continue;
    const title = String(entry?.title || imdbId).trim();
    if (!map.has(imdbId)) map.set(imdbId, { imdbId, title });
  }
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title, 'es', { sensitivity: 'base' }));
}

function mergeTargets(existing, incoming) {
  const map = new Map(existing.map((entry) => [entry.imdbId, entry]));
  for (const entry of incoming) {
    if (!map.has(entry.imdbId)) {
      map.set(entry.imdbId, entry);
    }
  }
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title, 'es', { sensitivity: 'base' }));
}

function sameTargets(a, b) {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => entry.imdbId === b[index]?.imdbId && entry.title === b[index]?.title);
}

async function writeReport(processedIssues) {
  const payload = {
    generatedAt: new Date().toISOString(),
    repository: OWNER_REPO,
    label: LABEL,
    processedIssues: processedIssues || []
  };
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[episode-sync] report: ${REPORT_PATH}`);
}

await main();
