#!/usr/bin/env node
/**
 * Sync role provisioning requests from GitHub issues into assets/users and assets/roles.
 *
 * Issues labeled `role-provision` must include:
 * ROLE_PROVISION_REQUEST
 * Action: create_agent
 * Name: ...
 * Email: ...
 * Role: agent
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
const ROLES_INDEX_PATH = path.join(PROJECT_ROOT, 'assets', 'roles', 'index.json');
const ROLES_AUDIT_PATH = path.join(PROJECT_ROOT, 'assets', 'roles', 'audit.json');
const ROLES_REQUESTS_PATH = path.join(PROJECT_ROOT, 'assets', 'roles', 'requests.json');
const OWNER_REPO = String(process.env.GITHUB_REPOSITORY || '').trim();
const TOKEN = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
const LABEL = 'role-provision';
const REPORT_PATH = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'mep-role-provision-report.json');

async function main() {
  if (!OWNER_REPO || !TOKEN) {
    console.log('[role-provision] skip: missing env');
    return;
  }

  await fs.mkdir(USERS_DIR, { recursive: true });
  await fs.mkdir(path.dirname(ROLES_INDEX_PATH), { recursive: true });

  const issues = await fetchAllIssues();
  const requests = issues.map(parseIssue).filter(Boolean);

  const userIndex = await loadUsersIndex();
  const roleIndex = await loadRolesIndex();
  const roleAudit = await loadJsonArrayFile(ROLES_AUDIT_PATH, 'events');
  const roleRequests = await loadJsonArrayFile(ROLES_REQUESTS_PATH, 'requests');

  const processedIssues = [];

  for (const req of requests) {
    const reqKey = `issue:${req.issueNumber}:${req.email}:${req.role}:${req.action}`;
    const requestBase = {
      key: reqKey,
      issueNumber: req.issueNumber,
      htmlUrl: req.htmlUrl,
      email: req.email,
      role: req.role,
      action: req.action,
      requestedBy: req.requestedBy || '',
      requestedAt: req.requestedAt,
      status: 'pending'
    };
    if (!roleRequests.items.some((item) => item.key === reqKey)) {
      roleRequests.items.push(requestBase);
    }

    if (req.action !== 'create_agent') continue;
    if (req.role !== 'agent') continue;

    const file = `${req.email}.json`;
    const userPayload = {
      name: req.name,
      email: req.email,
      role: 'agent',
      salt: req.salt,
      passwordHash: req.passwordHash,
      createdAt: req.requestedAt || new Date().toISOString(),
      createdBy: req.requestedBy || 'admin'
    };

    await fs.writeFile(path.join(USERS_DIR, file), `${JSON.stringify(userPayload, null, 2)}\n`, 'utf8');

    if (!userIndex.users.some((u) => u.email === req.email)) {
      userIndex.users.push({ email: req.email, file });
    }

    const existingReq = roleRequests.items.find((item) => item.key === reqKey);
    if (existingReq) {
      existingReq.status = 'approved';
      existingReq.resolvedAt = new Date().toISOString();
    }

    if (!roleIndex.roles.some((r) => String(r.name || '').trim().toLowerCase() === 'agent')) {
      roleIndex.roles.push({
        name: 'agent',
        description: 'Rol operativo creado por administrador.',
        createdAt: new Date().toISOString(),
        createdBy: req.requestedBy || 'admin'
      });
    }

    processedIssues.push({
      number: req.issueNumber,
      htmlUrl: req.htmlUrl,
      email: req.email,
      role: req.role,
      action: req.action
    });

    roleAudit.items.push({
      type: 'role_provision_approved',
      role: req.role,
      email: req.email,
      issueNumber: req.issueNumber,
      requestedBy: req.requestedBy || '',
      requestedAt: req.requestedAt,
      processedAt: new Date().toISOString()
    });
  }

  userIndex.users.sort((a, b) => String(a.email || '').localeCompare(String(b.email || ''), 'es', { sensitivity: 'base' }));
  await fs.writeFile(USERS_INDEX_PATH, `${JSON.stringify(userIndex, null, 2)}\n`, 'utf8');

  roleIndex.roles.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' }));
  await fs.writeFile(ROLES_INDEX_PATH, `${JSON.stringify(roleIndex, null, 2)}\n`, 'utf8');
  roleAudit.items.sort((a, b) => (Date.parse(b.processedAt || b.requestedAt || 0) || 0) - (Date.parse(a.processedAt || a.requestedAt || 0) || 0));
  await fs.writeFile(ROLES_AUDIT_PATH, `${JSON.stringify({ events: roleAudit.items.slice(0, 1000) }, null, 2)}\n`, 'utf8');
  roleRequests.items.sort((a, b) => (Date.parse(b.requestedAt || 0) || 0) - (Date.parse(a.requestedAt || 0) || 0));
  await fs.writeFile(ROLES_REQUESTS_PATH, `${JSON.stringify({ requests: roleRequests.items.slice(0, 2000) }, null, 2)}\n`, 'utf8');

  await fs.writeFile(REPORT_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), repository: OWNER_REPO, label: LABEL, processedIssues }, null, 2)}\n`, 'utf8');
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

    const items = await response.json();
    const rows = Array.isArray(items) ? items.filter((item) => !item.pull_request) : [];
    out.push(...rows);
    if (rows.length < 100) break;
    page += 1;
  }
  return out;
}

function parseIssue(issue) {
  const body = String(issue?.body || '');
  if (!/ROLE_PROVISION_REQUEST/i.test(body)) return null;
  const action = String((body.match(/^Action:\s*(.+)$/im) || [])[1] || '').trim().toLowerCase();
  const name = String((body.match(/^Name:\s*(.+)$/im) || [])[1] || '').trim();
  const email = normalizeEmail((body.match(/^Email:\s*(.+)$/im) || [])[1]);
  const role = String((body.match(/^Role:\s*(.+)$/im) || [])[1] || '').trim().toLowerCase();
  const salt = String((body.match(/^Salt:\s*(.+)$/im) || [])[1] || '').trim();
  const passwordHash = String((body.match(/^PasswordHash:\s*([0-9a-f]{64})$/im) || [])[1] || '').trim();
  const requestedBy = normalizeEmail((body.match(/^RequestedBy:\s*(.+)$/im) || [])[1]);
  const requestedAt = String((body.match(/^RequestedAt:\s*(.+)$/im) || [])[1] || '').trim() || new Date().toISOString();
  if (!action || !name || !email || !role || !salt || !passwordHash) return null;
  return {
    action,
    name,
    email,
    role,
    salt,
    passwordHash,
    requestedBy,
    requestedAt,
    issueNumber: issue.number,
    htmlUrl: issue.html_url
  };
}

async function loadUsersIndex() {
  const raw = await fs.readFile(USERS_INDEX_PATH, 'utf8').catch(() => '{"users":[]}');
  const parsed = JSON.parse(raw || '{"users":[]}');
  return {
    users: Array.isArray(parsed?.users) ? parsed.users.map((u) => ({ email: normalizeEmail(u.email), file: String(u.file || '').trim() || `${normalizeEmail(u.email)}.json` })).filter((u) => u.email) : []
  };
}

async function loadRolesIndex() {
  const raw = await fs.readFile(ROLES_INDEX_PATH, 'utf8').catch(() => '{"roles":[]}');
  const parsed = JSON.parse(raw || '{"roles":[]}');
  return {
    roles: Array.isArray(parsed?.roles) ? parsed.roles : []
  };
}

async function loadJsonArrayFile(filePath, key) {
  const fallback = { [key]: [] };
  const raw = await fs.readFile(filePath, 'utf8').catch(() => JSON.stringify(fallback));
  const parsed = JSON.parse(raw || JSON.stringify(fallback));
  return {
    items: Array.isArray(parsed?.[key]) ? parsed[key] : []
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

await main();
