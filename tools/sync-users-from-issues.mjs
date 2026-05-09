#!/usr/bin/env node
/**
 * Sync registered users from GitHub issues into assets/users/.
 *
 * Issues labeled `user-register` with body:
 * USER_REGISTRATION_REQUEST
 * Name: ...
 * Email: ...
 * Salt: ...
 * PasswordHash: ...
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const USERS_DIR = path.join(PROJECT_ROOT, 'assets', 'users');
const USERS_INDEX_PATH = path.join(USERS_DIR, 'index.json');
const OWNER_REPO = String(process.env.GITHUB_REPOSITORY || '').trim();
const TOKEN = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
const LABEL = 'user-register';
const REPORT_PATH = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'mep-user-register-report.json');

async function main() {
  if (!OWNER_REPO) {
    console.log('[user-register] skip: missing GITHUB_REPOSITORY');
    return;
  }

  if (!TOKEN) {
    console.log('[user-register] skip: missing GITHUB_TOKEN/GH_TOKEN');
    return;
  }

  await fs.mkdir(USERS_DIR, { recursive: true });
  const existingIndex = await loadUsersIndex();
  const { users, processedIssues } = await loadUsersFromIssues(existingIndex);
  const mergedIndex = mergeUsersIndex(existingIndex, users);

  await fs.writeFile(USERS_INDEX_PATH, `${JSON.stringify({ users: mergedIndex }, null, 2)}\n`, 'utf8');
  console.log(`[user-register] wrote ${USERS_INDEX_PATH}`);
  console.log(`[user-register] users: ${mergedIndex.length}`);

  await writeUserFiles(users);
  await closeProcessedIssues(processedIssues);
  await writeReport(processedIssues);
}

async function loadUsersIndex() {
  const raw = await fs.readFile(USERS_INDEX_PATH, 'utf8').catch(() => '');
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed?.users) ? parsed.users : [];
  return entries
    .map((entry) => normalizeIndexEntry(entry))
    .filter(Boolean)
    .sort((a, b) => a.email.localeCompare(b.email, 'es', { sensitivity: 'base' }));
}

function normalizeIndexEntry(entry) {
  const email = normalizeEmail(entry?.email);
  if (!email) return null;
  const file = String(entry?.file || `${email}.json`).trim();
  return { email, file };
}

async function loadUsersFromIssues(existingIndex) {
  const issues = await fetchAllIssues();
  const users = [];
  const processedIssues = [];
  for (const issue of issues) {
    const user = parseIssue(issue);
    if (!user) continue;
    const file = `${user.email}.json`;
    users.push({ ...user, file });
    processedIssues.push({
      number: issue.number,
      htmlUrl: issue.html_url,
      email: user.email,
      name: user.name
    });
  }

  for (const user of users) {
    const existing = existingIndex.find((entry) => entry.email === user.email);
    if (existing) user.file = existing.file || user.file;
  }

  return { users, processedIssues };
}

function parseIssue(issue) {
  const body = String(issue?.body || '');
  if (!/USER_REGISTRATION_REQUEST/i.test(body)) return null;
  const name = (body.match(/^Name:\s*(.+)$/im) || [])[1];
  const email = normalizeEmail((body.match(/^Email:\s*(.+)$/im) || [])[1]);
  const salt = (body.match(/^Salt:\s*(.+)$/im) || [])[1];
  const passwordHash = (body.match(/^PasswordHash:\s*([0-9a-f]{64})$/im) || [])[1];
  if (!name || !email || !salt || !passwordHash) return null;
  return {
    name: String(name).trim(),
    email,
    salt: String(salt).trim(),
    passwordHash: String(passwordHash).trim(),
    createdAt: new Date().toISOString()
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

function mergeUsersIndex(existing, incoming) {
  const map = new Map(existing.map((entry) => [entry.email, entry]));
  for (const user of incoming) {
    map.set(user.email, { email: user.email, file: user.file || `${user.email}.json` });
  }
  return [...map.values()].sort((a, b) => a.email.localeCompare(b.email, 'es', { sensitivity: 'base' }));
}

async function writeUserFiles(users) {
  for (const user of users) {
    const filePath = path.join(USERS_DIR, user.file || `${user.email}.json`);
    const payload = {
      name: user.name,
      email: user.email,
      salt: user.salt,
      passwordHash: user.passwordHash,
      createdAt: user.createdAt
    };
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`[user-register] wrote ${filePath}`);
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
    console.log(`[user-register] closed issue #${issue.number}`);
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
  console.log(`[user-register] report: ${REPORT_PATH}`);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

await main();
