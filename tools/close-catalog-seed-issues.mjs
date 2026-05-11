#!/usr/bin/env node
/**
 * Closes catalog-seed-sync issues that were already processed.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const OWNER_REPO = String(process.env.GITHUB_REPOSITORY || '').trim();
const TOKEN = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
const REPORT_PATH = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'mep-catalog-seed-report.json');

async function main() {
  if (!OWNER_REPO || !TOKEN) return;
  const raw = await fs.readFile(REPORT_PATH, 'utf8').catch(() => '');
  if (!raw.trim()) return;
  const report = JSON.parse(raw);
  const issues = Array.isArray(report?.processedIssues) ? report.processedIssues : [];
  for (const issue of issues) {
    if (!issue?.number) continue;
    await closeIssue(issue.number);
  }
}

async function closeIssue(number) {
  const url = `https://api.github.com/repos/${OWNER_REPO}/issues/${number}`;
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
    throw new Error(`Failed to close issue #${number} (${response.status} ${response.statusText})\n${text}`.trim());
  }
}

await main();
