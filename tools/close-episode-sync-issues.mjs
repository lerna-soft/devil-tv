#!/usr/bin/env node
/**
 * Closes episode-sync issues that were already processed by the build step.
 *
 * Expects a report written by sync-episode-targets-from-issues.mjs in RUNNER_TEMP.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const OWNER_REPO = String(process.env.GITHUB_REPOSITORY || '').trim();
const TOKEN = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
const REPORT_PATH = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'mep-episode-sync-report.json');

async function main() {
  if (!OWNER_REPO) {
    console.log('[episode-close] skip: missing GITHUB_REPOSITORY');
    return;
  }
  if (!TOKEN) {
    console.log('[episode-close] skip: missing GITHUB_TOKEN/GH_TOKEN');
    return;
  }

  const raw = await fs.readFile(REPORT_PATH, 'utf8').catch(() => '');
  if (!raw.trim()) {
    console.log(`[episode-close] skip: missing report ${REPORT_PATH}`);
    return;
  }

  const report = JSON.parse(raw);
  const issues = Array.isArray(report?.processedIssues) ? report.processedIssues : [];
  if (issues.length === 0) {
    console.log('[episode-close] no issues to close');
    return;
  }

  for (const issue of issues) {
    if (!issue?.number) continue;
    await closeIssue(issue.number, issue.title, issue.imdbId);
  }

  console.log(`[episode-close] closed ${issues.length} issues`);
}

async function closeIssue(number, title, imdbId) {
  const url = new URL(`https://api.github.com/repos/${OWNER_REPO}/issues/${number}`);
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'media-evaluation-platform-static'
    },
    body: JSON.stringify({
      state: 'closed'
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GitHub close issue ${number} failed: ${response.status} ${response.statusText}\n${text}`.trim());
  }

  console.log(`[episode-close] closed #${number} ${title || imdbId || ''}`.trim());
}

await main();
