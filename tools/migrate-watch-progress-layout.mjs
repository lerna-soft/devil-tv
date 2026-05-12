#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORE_DIR = path.join(PROJECT_ROOT, 'assets', 'watch-progress');
const USERS_DIR = path.join(STORE_DIR, 'users');
const INDEX_PATH = path.join(STORE_DIR, 'index.json');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function userFile(email) {
  return `users/${normalizeEmail(email)}/data.json`;
}

async function loadIndex() {
  const raw = await fs.readFile(INDEX_PATH, 'utf8').catch(() => '');
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed?.users) ? parsed.users : [];
}

async function main() {
  await fs.mkdir(USERS_DIR, { recursive: true });
  const indexUsers = await loadIndex();
  const emails = new Set();

  for (const row of indexUsers) {
    const email = normalizeEmail(row?.email);
    if (email) emails.add(email);
  }

  const dir = await fs.readdir(STORE_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of dir) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    if (entry.name === 'index.json') continue;
    emails.add(normalizeEmail(entry.name.replace(/\.json$/i, '')));
  }

  for (const email of emails) {
    if (!email) continue;
    const oldPath = path.join(STORE_DIR, `${email}.json`);
    const newPath = path.join(STORE_DIR, userFile(email));
    const existsNew = await fs.readFile(newPath, 'utf8').then((s) => Boolean(s.trim())).catch(() => false);
    if (existsNew) continue;
    const oldRaw = await fs.readFile(oldPath, 'utf8').catch(() => '');
    if (!oldRaw.trim()) continue;
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    await fs.writeFile(newPath, oldRaw, 'utf8');
    console.log(`[migrate-watch-progress] ${oldPath} -> ${newPath}`);
  }

  const users = [...emails]
    .filter(Boolean)
    .map((email) => ({ email, file: userFile(email) }))
    .sort((a, b) => a.email.localeCompare(b.email, 'es', { sensitivity: 'base' }));
  await fs.writeFile(INDEX_PATH, `${JSON.stringify({ users }, null, 2)}\n`, 'utf8');
  console.log(`[migrate-watch-progress] wrote ${INDEX_PATH} (${users.length} users)`);
}

await main();
