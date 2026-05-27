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
const ANALYTICS_DIR = path.join(PROJECT_ROOT, 'assets', 'watch-analytics');
const USERS_STORE_DIR = path.join(PROJECT_ROOT, 'assets', 'users');
const INDEX_PATH = path.join(STORE_DIR, 'index.json');
const USERS_INDEX_PATH = path.join(USERS_STORE_DIR, 'index.json');
const USERS_DIR = path.join(STORE_DIR, 'users');
const ANALYTICS_EVENTS_PATH = path.join(ANALYTICS_DIR, 'events.json');
const ANALYTICS_BY_CONTENT_PATH = path.join(ANALYTICS_DIR, 'by-content.json');
const ANALYTICS_BY_USER_PATH = path.join(ANALYTICS_DIR, 'by-user.json');
const ANALYTICS_SUMMARY_PATH = path.join(ANALYTICS_DIR, 'summary.json');
const ANALYTICS_XAPI_DIR = path.join(ANALYTICS_DIR, 'xapi');
const ANALYTICS_XAPI_USERS_DIR = path.join(ANALYTICS_XAPI_DIR, 'users');
const ANALYTICS_XAPI_INDEX_PATH = path.join(ANALYTICS_XAPI_DIR, 'index.json');
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
  await fs.mkdir(USERS_DIR, { recursive: true });
  await fs.mkdir(ANALYTICS_DIR, { recursive: true });
  await fs.mkdir(ANALYTICS_XAPI_DIR, { recursive: true });
  await fs.mkdir(ANALYTICS_XAPI_USERS_DIR, { recursive: true });
  const existingIndex = await loadIndex();
  const { users, processedIssues } = await loadUsersFromIssues();
  const mergedIndex = mergeIndex(existingIndex, users);

  await fs.writeFile(INDEX_PATH, `${JSON.stringify({ users: mergedIndex }, null, 2)}\n`, 'utf8');
  await writeUserFiles(users);
  await writeAnalytics(mergedIndex);
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
  const file = String(entry?.file || '').trim();
  return { email, file: file || userDataRelativePath(email) };
}

function userDataRelativePath(email) {
  return `users/${normalizeEmail(email)}/data.json`;
}

function resolveUserPath(file) {
  return path.join(STORE_DIR, String(file || '').trim());
}

async function loadUsersFromIssues() {
  let issues = await fetchAllIssues();
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
    const file = userDataRelativePath(progress.email);
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
    user.file = userDataRelativePath(user.email);
  }

  return { users: dedupeUsers(users), processedIssues: dedupeIssues(processedIssues) };
}

function parseIssue(issue) {
  const body = String(issue?.body || '');
  if (!/WATCH_PROGRESS_SYNC_REQUEST/i.test(body)) return null;
  const email = normalizeEmail(extractIssueField(body, 'Email'));
  const name = String(extractIssueField(body, 'Name') || '').trim();
  const imdbId = String(extractIssueField(body, 'IMDb') || '').trim();
  const tmdbId = String(extractIssueField(body, 'TMDB') || '').trim();
  const season = positiveInteger(extractIssueField(body, 'Season'), 1);
  const episode = positiveInteger(extractIssueField(body, 'Episode'), 1);
  const progress = Number(extractIssueField(body, 'Progress') || 0);
  const title = String(extractIssueField(body, 'Title') || '').trim();
  const type = String(extractIssueField(body, 'Type') || '').trim().toLowerCase();
  const playerStatus = String(extractIssueField(body, 'PlayerStatus') || '').trim().toLowerCase();
  const eventType = String(extractIssueField(body, 'EventType') || '').trim().toLowerCase();
  const startedAt = String(extractIssueField(body, 'StartedAt') || '').trim();
  const completedAt = String(extractIssueField(body, 'CompletedAt') || '').trim();
  const preferenceAction = String(extractIssueField(body, 'PreferenceAction') || '').trim().toLowerCase();
  const preferenceValue = String(extractIssueField(body, 'PreferenceValue') || '').trim().toLowerCase();
  // Campos nuevos (geo + device) — opcionales y best-effort. Issues viejos no
  // los tienen y eso es OK (los campos quedan vacíos en el history event).
  const country = String(extractIssueField(body, 'Country') || '').trim().toUpperCase().slice(0, 3);
  const countryName = String(extractIssueField(body, 'CountryName') || '').trim().slice(0, 60);
  const city = String(extractIssueField(body, 'City') || '').trim().slice(0, 60);
  const region = String(extractIssueField(body, 'Region') || '').trim().slice(0, 60);
  const device = String(extractIssueField(body, 'Device') || '').trim().toLowerCase().slice(0, 12);
  const browser = String(extractIssueField(body, 'Browser') || '').trim().slice(0, 20);
  const locale = String(extractIssueField(body, 'Locale') || '').trim().slice(0, 12);
  const timezone = String(extractIssueField(body, 'Timezone') || '').trim().slice(0, 40);
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
    eventType,
    startedAt,
    completedAt,
    preferenceAction,
    preferenceValue,
    country,
    countryName,
    city,
    region,
    device,
    browser,
    locale,
    timezone,
    updatedAt: parseIssueDate(issue),
    progressKey: `${imdbId || tmdbId}:${season}x${episode}`
  };
}

function extractIssueField(body, label) {
  const pattern = new RegExp(`^${escapeRegex(label)}:[ \\t]*(.*)$`, 'im');
  const match = String(body || '').match(pattern);
  return String(match?.[1] || '').trim();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const map = new Map(existing.map((entry) => [entry.email, { email: entry.email, file: userDataRelativePath(entry.email) }]));
  for (const user of incoming) map.set(user.email, { email: user.email, file: userDataRelativePath(user.email) });
  return [...map.values()].sort((a, b) => a.email.localeCompare(b.email, 'es', { sensitivity: 'base' }));
}

async function writeUserFiles(users) {
  for (const user of users) {
    const filePath = resolveUserPath(user.file || userDataRelativePath(user.email));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const existingRaw = await fs.readFile(filePath, 'utf8').catch(() => '');
    const existing = existingRaw.trim() ? safeJson(existingRaw) : {};
    const existingProgress = existing?.progress && typeof existing.progress === 'object' ? existing.progress : {};
    const key = user.imdbId || user.tmdbId;
    const previous = existingProgress[key] && typeof existingProgress[key] === 'object' ? existingProgress[key] : {};
    const previousUpdatedMs = Date.parse(previous?.updatedAt || 0) || 0;
    const incomingUpdatedMs = Date.parse(user?.updatedAt || 0) || 0;
    // Si el issue entrante es más viejo que lo persistido, no pisamos los
    // campos "última posición" (lastSeason/lastEpisode/lastProgress). Esto
    // evita que un drain fuera de orden (issues procesados out-of-order)
    // retroceda el avance del user. Los demás campos (history, watched) sí
    // se mergean sin importar el orden.
    const acceptIncomingForLast = incomingUpdatedMs >= previousUpdatedMs;
    const updatedWatched = applyEventToWatched(previous?.watched || {}, user);
    const mergedProgress = {
      ...existingProgress,
      [key]: {
        ...previous,
        imdbId: user.imdbId,
        tmdbId: user.tmdbId,
        lastSeason: acceptIncomingForLast ? user.season : previous?.lastSeason || user.season,
        lastEpisode: acceptIncomingForLast ? user.episode : previous?.lastEpisode || user.episode,
        progress: acceptIncomingForLast ? user.progress : (previous?.progress ?? user.progress),
        lastProgress: acceptIncomingForLast ? user.progress : (previous?.lastProgress ?? user.progress),
        updatedAt: acceptIncomingForLast ? user.updatedAt : (previous?.updatedAt || user.updatedAt),
        watched: updatedWatched
      }
    };
    const historyEntry = {
      eventId: buildEventId(user),
      contentId: key,
      episodeKey: `s${user.season}e${user.episode}`,
      userEmail: user.email,
      userName: user.name || existing?.name || '',
      imdbId: user.imdbId,
      tmdbId: user.tmdbId,
      title: user.title || '',
      type: user.type || '',
      season: user.season,
      episode: user.episode,
      progress: user.progress,
      eventType: user.eventType || inferEventType(user.playerStatus, user.progress),
      playerStatus: user.playerStatus || 'playing',
      startedAt: user.startedAt || '',
      completedAt: user.completedAt || '',
      updatedAt: user.updatedAt,
      // Geo + device. Solo se persisten si vienen en el issue body (issues
      // viejos no los tienen). El dashboard maneja ausencia con "—".
      country: user.country || '',
      countryName: user.countryName || '',
      city: user.city || '',
      region: user.region || '',
      device: user.device || '',
      browser: user.browser || '',
      locale: user.locale || '',
      timezone: user.timezone || ''
    };
    const history = mergeHistory(existing?.history || [], [historyEntry]);
    const payload = {
      email: user.email,
      name: user.name || existing?.name || '',
      updatedAt: maxIsoString(existing?.updatedAt, user.updatedAt),
      progress: mergedProgress,
      preferences: mergePreferences(existing?.preferences || {}, user),
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

    // Particionado por título: escribir índice del usuario + un archivo por
    // título. Ayuda al admin (carga ligera de overview) y reduce contención
    // del data.json monolítico cuando llegan muchos issues seguidos.
    // El data.json sigue siendo la fuente principal — esto es escritura
    // extra para que el front/admin puedan migrar gradualmente.
    await writePartitionedUserFiles(user, payload);
  }
}

// Aplica el evento entrante al map de watched{} del título. Antes esto solo
// vivía en localStorage del frontend, así que el getResumeTarget remoto no
// podía avanzar al siguiente episodio cuando se completaba uno desde otro
// dispositivo.
function applyEventToWatched(existingWatched, user) {
  const watched = { ...(existingWatched && typeof existingWatched === 'object' ? existingWatched : {}) };
  const season = positiveInteger(user?.season, 1);
  const episode = positiveInteger(user?.episode, 1);
  const epKey = `s${season}e${episode}`;
  const prev = watched[epKey] && watched[epKey] !== true && typeof watched[epKey] === 'object' ? watched[epKey] : null;
  const eventType = String(user?.eventType || inferEventType(user?.playerStatus, user?.progress) || '').toLowerCase();
  const startedIso = String(user?.startedAt || '').trim();
  const completedIso = String(user?.completedAt || '').trim();
  const progressNum = Number(user?.progress || 0);
  const next = {
    startedAt: startedIso || prev?.startedAt || user?.updatedAt || '',
    completedAt: completedIso || prev?.completedAt || (eventType === 'completed' ? (user?.updatedAt || '') : ''),
    lastProgress: progressNum || prev?.lastProgress || 0
  };
  // Una vez completedAt está set, no lo desactivamos — un 'started' posterior
  // no debe revertir un 'completed' anterior.
  if (prev?.completedAt && !next.completedAt) next.completedAt = prev.completedAt;
  watched[epKey] = next;
  return watched;
}

async function writePartitionedUserFiles(user, payload) {
  try {
    const userDir = path.join(USERS_DIR, normalizeEmail(user.email));
    const titlesDir = path.join(userDir, 'titles');
    await fs.mkdir(titlesDir, { recursive: true });

    const progress = payload?.progress && typeof payload.progress === 'object' ? payload.progress : {};
    const titleIds = Object.keys(progress).filter(Boolean).sort();

    // Mini-progress map: campos suficientes para reconstruir lastWatch/Continuar
    // Viendo/getResumeTarget sin bajar los titles. Se excluye watched{} y
    // history (esos viven en titles/<id>.json y se cargan lazy).
    const slimProgress = {};
    for (const id of titleIds) {
      const entry = progress[id] || {};
      slimProgress[id] = {
        imdbId: entry.imdbId || '',
        tmdbId: entry.tmdbId || '',
        lastSeason: entry.lastSeason || 1,
        lastEpisode: entry.lastEpisode || 1,
        progress: entry.progress || 0,
        lastProgress: entry.lastProgress || 0,
        updatedAt: entry.updatedAt || ''
      };
    }

    // Index: visión general (sin watched ni history). Lo usa el front para
    // Continuar Viendo + getResumeTarget sin bajar los titles por separado.
    const index = {
      email: payload.email,
      name: payload.name || '',
      updatedAt: payload.updatedAt || '',
      lastWatch: payload.lastWatch || null,
      lastSelection: payload.lastSelection || null,
      preferences: payload.preferences || {},
      titles: titleIds,
      progress: slimProgress
    };
    const indexPath = path.join(userDir, 'index.json');
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

    // Por título: detalle profundo (watched + history filtrada por contentId).
    const allHistory = Array.isArray(payload.history) ? payload.history : [];
    for (const titleId of titleIds) {
      const entry = progress[titleId] || {};
      const titleHistory = allHistory.filter((h) => String(h?.contentId || '') === titleId);
      const titlePayload = {
        imdbId: entry.imdbId || titleId,
        tmdbId: entry.tmdbId || '',
        lastSeason: entry.lastSeason || 1,
        lastEpisode: entry.lastEpisode || 1,
        progress: entry.progress || 0,
        lastProgress: entry.lastProgress || 0,
        updatedAt: entry.updatedAt || '',
        watched: entry.watched || {},
        history: titleHistory
      };
      const titlePath = path.join(titlesDir, `${sanitizeTitleId(titleId)}.json`);
      await fs.writeFile(titlePath, `${JSON.stringify(titlePayload, null, 2)}\n`, 'utf8');
    }
    console.log(`[watch-progress] partitioned ${user.email}: ${titleIds.length} titles + index.json`);
  } catch (err) {
    console.warn(`[watch-progress] partitioned write failed for ${user.email}: ${err?.message || err}`);
  }
}

function sanitizeTitleId(id) {
  return String(id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
}

function mergePreferences(existing, user) {
  const current = existing && typeof existing === 'object' ? existing : {};
  const action = String(user?.preferenceAction || '').trim().toLowerCase();
  const value = String(user?.preferenceValue || '').trim().toLowerCase();
  const id = String(user?.imdbId || user?.tmdbId || '').trim();
  if (!id || !action) return current;

  const likes = { ...(current.likes || {}) };
  const watchLater = { ...(current.watchLater || {}) };

  if (action === 'like') {
    if (value === 'liked') likes[id] = 1;
    else delete likes[id];
  }
  if (action === 'later') {
    if (value === 'saved') watchLater[id] = true;
    else delete watchLater[id];
  }

  return {
    likes,
    watchLater,
    updatedAt: user.updatedAt
  };
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
      eventId: String(row.eventId || buildEventId(row)).trim(),
      contentId: id,
      episodeKey: `s${season}e${episode}`,
      userEmail: normalizeEmail(row.userEmail || ''),
      userName: String(row.userName || '').trim(),
      imdbId: String(row.imdbId || '').trim(),
      tmdbId: String(row.tmdbId || '').trim(),
      title: String(row.title || '').trim(),
      type: String(row.type || '').trim(),
      season,
      episode,
      progress: Number(row.progress || 0),
      eventType: String(row.eventType || inferEventType(status, row.progress)).trim().toLowerCase(),
      playerStatus: status,
      startedAt: String(row.startedAt || '').trim(),
      completedAt: String(row.completedAt || '').trim(),
      updatedAt: at,
      // Geo + device (best-effort, vacíos en events viejos).
      country: String(row.country || '').toUpperCase().slice(0, 3),
      countryName: String(row.countryName || ''),
      city: String(row.city || ''),
      region: String(row.region || ''),
      device: String(row.device || '').toLowerCase(),
      browser: String(row.browser || ''),
      locale: String(row.locale || ''),
      timezone: String(row.timezone || '')
    });
  }
  return [...map.values()]
    .sort((a, b) => (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0))
    .slice(0, 500);
}

async function writeAnalytics(indexUsers) {
  const users = [];
  for (const entry of indexUsers || []) {
    const email = normalizeEmail(entry?.email);
    const file = String(entry?.file || '').trim();
    if (!email || !file) continue;
    const payload = safeJson(await fs.readFile(resolveUserPath(file), 'utf8').catch(() => ''));
    if (!payload || typeof payload !== 'object') continue;
    users.push({
      email,
      name: String(payload?.name || '').trim(),
      updatedAt: String(payload?.updatedAt || '').trim(),
      progress: payload?.progress && typeof payload.progress === 'object' ? payload.progress : {},
      history: Array.isArray(payload?.history) ? payload.history : []
    });
  }

  const registeredUsers = await loadRegisteredUsers();
  const mergedUsers = mergeAnalyticsUsers(registeredUsers, users);

  const events = buildAnalyticsEvents(mergedUsers);
  const byContent = buildAnalyticsByContent(events);
  const byUser = buildAnalyticsByUser(mergedUsers, events);
  const xapi = buildXapiIndex(byUser, events);
  const summary = buildAnalyticsSummary(mergedUsers, events, byContent);

  await fs.writeFile(ANALYTICS_EVENTS_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), events }, null, 2)}\n`, 'utf8');
  await fs.writeFile(ANALYTICS_BY_CONTENT_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), items: byContent }, null, 2)}\n`, 'utf8');
  await fs.writeFile(ANALYTICS_BY_USER_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), users: byUser }, null, 2)}\n`, 'utf8');
  await fs.writeFile(ANALYTICS_SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeXapiFiles(xapi);
  console.log(`[watch-progress] wrote ${ANALYTICS_EVENTS_PATH}`);
  console.log(`[watch-progress] wrote ${ANALYTICS_BY_CONTENT_PATH}`);
  console.log(`[watch-progress] wrote ${ANALYTICS_BY_USER_PATH}`);
  console.log(`[watch-progress] wrote ${ANALYTICS_SUMMARY_PATH}`);
  console.log(`[watch-progress] wrote ${ANALYTICS_XAPI_INDEX_PATH}`);
}

async function loadRegisteredUsers() {
  const raw = await fs.readFile(USERS_INDEX_PATH, 'utf8').catch(() => '');
  const parsed = raw.trim() ? safeJson(raw) : {};
  const indexUsers = Array.isArray(parsed?.users) ? parsed.users : [];
  const out = [];
  for (const entry of indexUsers) {
    const file = String(entry?.file || '').trim();
    const payload = file ? safeJson(await fs.readFile(path.join(USERS_STORE_DIR, file), 'utf8').catch(() => '')) : {};
    const email = normalizeEmail(payload?.email || entry?.email || '');
    if (!email) continue;
    out.push({
      email,
      name: String(payload?.name || '').trim(),
      role: String(payload?.role || 'viewer').trim().toLowerCase(),
      createdAt: String(payload?.createdAt || '').trim(),
      updatedAt: String(payload?.updatedAt || payload?.createdAt || '').trim(),
      progress: {},
      history: []
    });
  }
  return out;
}

function mergeAnalyticsUsers(registeredUsers, activeUsers) {
  const map = new Map();
  for (const user of registeredUsers || []) {
    map.set(user.email, {
      email: user.email,
      name: String(user.name || '').trim(),
      role: String(user.role || 'viewer').trim().toLowerCase(),
      createdAt: String(user.createdAt || '').trim(),
      updatedAt: String(user.updatedAt || '').trim(),
      progress: {},
      history: []
    });
  }
  for (const user of activeUsers || []) {
    const current = map.get(user.email) || {
      email: user.email,
      name: '',
      role: 'viewer',
      createdAt: '',
      updatedAt: ''
    };
    map.set(user.email, {
      ...current,
      email: user.email,
      name: String(user.name || current.name || '').trim(),
      updatedAt: maxIsoString(current.updatedAt, user.updatedAt),
      progress: user.progress && typeof user.progress === 'object' ? user.progress : {},
      history: Array.isArray(user.history) ? user.history : []
    });
  }
  return [...map.values()].sort((a, b) => a.email.localeCompare(b.email, 'es', { sensitivity: 'base' }));
}

function buildAnalyticsEvents(users) {
  const map = new Map();
  for (const user of users || []) {
    for (const rawEvent of user.history || []) {
      const normalized = normalizeAnalyticsEvent(rawEvent, user);
      if (!normalized) continue;
      map.set(normalized.eventId, normalized);
    }
  }
  return [...map.values()].sort((a, b) => (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0));
}

function normalizeAnalyticsEvent(rawEvent, user) {
  const imdbId = String(rawEvent?.imdbId || '').trim();
  const tmdbId = String(rawEvent?.tmdbId || '').trim();
  const contentId = String(rawEvent?.contentId || imdbId || tmdbId).trim();
  const updatedAt = String(rawEvent?.updatedAt || user?.updatedAt || '').trim();
  if (!contentId || !updatedAt) return null;
  const season = positiveInteger(rawEvent?.season, 1);
  const episode = positiveInteger(rawEvent?.episode, 1);
  const progress = Number(rawEvent?.progress || 0);
  const playerStatus = String(rawEvent?.playerStatus || '').trim().toLowerCase() || 'playing';
  const eventType = String(rawEvent?.eventType || inferEventType(playerStatus, progress)).trim().toLowerCase();
  const userEmail = normalizeEmail(rawEvent?.userEmail || user?.email || '');
  return {
    eventId: String(rawEvent?.eventId || buildEventId({ ...rawEvent, userEmail, updatedAt })).trim(),
    contentId,
    episodeKey: String(rawEvent?.episodeKey || `s${season}e${episode}`).trim(),
    userEmail,
    userName: String(rawEvent?.userName || user?.name || '').trim(),
    imdbId,
    tmdbId,
    title: String(rawEvent?.title || contentId).trim(),
    type: String(rawEvent?.type || '').trim().toLowerCase() || 'movie',
    season,
    episode,
    progress,
    progressValue: progress,
    progressPercent: progress >= 0 && progress <= 100 ? clamp(progress, 0, 100) : null,
    eventType,
    playerStatus,
    startedAt: sanitizeTelemetryField(rawEvent?.startedAt),
    completedAt: sanitizeTelemetryField(rawEvent?.completedAt),
    updatedAt
  };
}

function buildAnalyticsByContent(events) {
  const map = new Map();
  for (const event of events || []) {
    const contentId = String(event?.contentId || '').trim();
    if (!contentId) continue;
    const bucket = map.get(contentId) || {
      contentId,
      imdbId: String(event?.imdbId || '').trim(),
      tmdbId: String(event?.tmdbId || '').trim(),
      title: String(event?.title || contentId).trim(),
      type: String(event?.type || '').trim().toLowerCase() || 'movie',
      totalEvents: 0,
      totalStarts: 0,
      totalCompletions: 0,
      totalPlaybackProgress: 0,
      uniqueUsers: 0,
      completionRate: 0,
      lastActivityAt: '',
      users: {},
      episodes: {}
    };
    bucket.totalEvents += 1;
    if (event.eventType === 'started') bucket.totalStarts += 1;
    if (event.eventType === 'completed' || event.playerStatus === 'completed') bucket.totalCompletions += 1;
    bucket.totalPlaybackProgress += Number(event.progress || 0);
    bucket.lastActivityAt = maxIsoString(bucket.lastActivityAt, event.updatedAt);

    const userEmail = normalizeEmail(event.userEmail);
    if (userEmail) {
      const userBucket = bucket.users[userEmail] || {
        userEmail,
        userName: String(event.userName || '').trim(),
        playCount: 0,
        completedCount: 0,
        startedCount: 0,
        totalPlaybackProgress: 0,
        lastSeenAt: '',
        lastSeason: 0,
        lastEpisode: 0
      };
      userBucket.playCount += 1;
      if (event.eventType === 'started') userBucket.startedCount += 1;
      if (event.eventType === 'completed' || event.playerStatus === 'completed') userBucket.completedCount += 1;
      userBucket.totalPlaybackProgress += Number(event.progress || 0);
      userBucket.lastSeenAt = maxIsoString(userBucket.lastSeenAt, event.updatedAt);
      userBucket.lastSeason = positiveInteger(event.season, userBucket.lastSeason || 1);
      userBucket.lastEpisode = positiveInteger(event.episode, userBucket.lastEpisode || 1);
      bucket.users[userEmail] = userBucket;
    }

    const episodeKey = String(event.episodeKey || `s${event.season}e${event.episode}`).trim();
    const episodeBucket = bucket.episodes[episodeKey] || {
      season: positiveInteger(event.season, 1),
      episode: positiveInteger(event.episode, 1),
      totalEvents: 0,
      totalStarts: 0,
      totalCompletions: 0,
      totalPlaybackProgress: 0,
      uniqueUsers: 0,
      lastActivityAt: '',
      users: {}
    };
    episodeBucket.totalEvents += 1;
    if (event.eventType === 'started') episodeBucket.totalStarts += 1;
    if (event.eventType === 'completed' || event.playerStatus === 'completed') episodeBucket.totalCompletions += 1;
    episodeBucket.totalPlaybackProgress += Number(event.progress || 0);
    episodeBucket.lastActivityAt = maxIsoString(episodeBucket.lastActivityAt, event.updatedAt);
    if (userEmail) episodeBucket.users[userEmail] = true;
    bucket.episodes[episodeKey] = episodeBucket;

    map.set(contentId, bucket);
  }

  return [...map.values()]
    .map((bucket) => {
      const userEmails = Object.keys(bucket.users);
      const episodes = Object.fromEntries(Object.entries(bucket.episodes).map(([episodeKey, episodeBucket]) => [
        episodeKey,
        {
          ...episodeBucket,
          uniqueUsers: Object.keys(episodeBucket.users || {}).length,
          completionRate: episodeBucket.totalStarts > 0 ? roundRatio(episodeBucket.totalCompletions / episodeBucket.totalStarts) : 0
        }
      ]));
      return {
        ...bucket,
        uniqueUsers: userEmails.length,
        completionRate: bucket.totalStarts > 0 ? roundRatio(bucket.totalCompletions / bucket.totalStarts) : 0,
        avgPlaybackProgress: bucket.totalEvents > 0 ? roundRatio(bucket.totalPlaybackProgress / bucket.totalEvents) : 0,
        users: bucket.users,
        episodes
      };
    })
    .sort((a, b) => b.totalEvents - a.totalEvents || (Date.parse(b.lastActivityAt || 0) || 0) - (Date.parse(a.lastActivityAt || 0) || 0));
}

function buildAnalyticsByUser(users, events) {
  const map = new Map();
  for (const user of users || []) {
    map.set(user.email, {
      userEmail: user.email,
      userName: String(user.name || '').trim(),
      role: String(user.role || 'viewer').trim().toLowerCase(),
      createdAt: String(user.createdAt || '').trim(),
      updatedAt: String(user.updatedAt || '').trim(),
      totalEvents: 0,
      totalStarts: 0,
      totalCompletions: 0,
      totalPlaybackProgress: 0,
      uniqueContentCount: 0,
      lastActivityAt: '',
      completedContentIds: [],
      inProgressContentIds: [],
      content: {}
    });
  }

  for (const event of events || []) {
    const email = normalizeEmail(event.userEmail);
    if (!email) continue;
    const bucket = map.get(email) || {
      userEmail: email,
      userName: String(event.userName || '').trim(),
      role: 'viewer',
      createdAt: '',
      updatedAt: '',
      totalEvents: 0,
      totalStarts: 0,
      totalCompletions: 0,
      totalPlaybackProgress: 0,
      uniqueContentCount: 0,
      lastActivityAt: '',
      completedContentIds: [],
      inProgressContentIds: [],
      content: {}
    };
    bucket.totalEvents += 1;
    if (event.eventType === 'started') bucket.totalStarts += 1;
    if (event.eventType === 'completed' || event.playerStatus === 'completed') bucket.totalCompletions += 1;
    bucket.totalPlaybackProgress += Number(event.progress || 0);
    bucket.lastActivityAt = maxIsoString(bucket.lastActivityAt, event.updatedAt);
    const contentId = String(event.contentId || '').trim();
    const contentBucket = bucket.content[contentId] || {
      contentId,
      imdbId: String(event.imdbId || '').trim(),
      tmdbId: String(event.tmdbId || '').trim(),
      title: String(event.title || contentId).trim(),
      type: String(event.type || '').trim().toLowerCase() || 'movie',
      playCount: 0,
      completed: false,
      maxProgressValue: 0,
      maxProgressPercent: 0,
      lastSeenAt: ''
    };
    contentBucket.playCount += 1;
    contentBucket.maxProgressValue = Math.max(contentBucket.maxProgressValue, Number(event.progressValue || event.progress || 0));
    if (event.progressPercent != null) contentBucket.maxProgressPercent = Math.max(contentBucket.maxProgressPercent, Number(event.progressPercent || 0));
    if (event.eventType === 'completed' || event.playerStatus === 'completed') contentBucket.completed = true;
    contentBucket.lastSeenAt = maxIsoString(contentBucket.lastSeenAt, event.updatedAt);
    bucket.content[contentId] = contentBucket;
    map.set(email, bucket);
  }

  return [...map.values()]
    .map((bucket) => {
      const contentRows = Object.values(bucket.content || {});
      return {
        ...bucket,
        uniqueContentCount: contentRows.length,
        avgPlaybackProgress: bucket.totalEvents > 0 ? roundRatio(bucket.totalPlaybackProgress / bucket.totalEvents) : 0,
        completedContentIds: contentRows.filter((row) => row.completed).map((row) => row.contentId),
        inProgressContentIds: contentRows.filter((row) => !row.completed && row.maxProgressValue > 0).map((row) => row.contentId),
        content: Object.fromEntries(contentRows.map((row) => [row.contentId, row]))
      };
    })
    .sort((a, b) => b.totalEvents - a.totalEvents || (Date.parse(b.lastActivityAt || 0) || 0) - (Date.parse(a.lastActivityAt || 0) || 0));
}

function buildAnalyticsSummary(users, events, byContent) {
  const startedEvents = (events || []).filter((event) => event.eventType === 'started');
  const completedEvents = (events || []).filter((event) => event.eventType === 'completed' || event.playerStatus === 'completed');
  const activeUserEmails = new Set((events || []).map((event) => normalizeEmail(event.userEmail)).filter(Boolean));
  return {
    generatedAt: new Date().toISOString(),
    totalUsers: (users || []).length,
    activeUsers: activeUserEmails.size,
    totalEvents: (events || []).length,
    totalStarts: startedEvents.length,
    totalCompletions: completedEvents.length,
    overallCompletionRate: startedEvents.length > 0 ? roundRatio(completedEvents.length / startedEvents.length) : 0,
    trackedTitles: (byContent || []).length,
    mostWatchedContent: (byContent || []).slice(0, 10).map((row) => ({
      contentId: row.contentId,
      title: row.title,
      type: row.type,
      totalEvents: row.totalEvents,
      uniqueUsers: row.uniqueUsers,
      completionRate: row.completionRate
    }))
  };
}

function buildXapiIndex(byUser, events) {
  const eventsByUser = new Map();
  for (const event of events || []) {
    const email = normalizeEmail(event.userEmail);
    if (!email) continue;
    const rows = eventsByUser.get(email) || [];
    rows.push(event);
    eventsByUser.set(email, rows);
  }

  const users = [];
  for (const row of byUser || []) {
    const email = normalizeEmail(row?.userEmail);
    const statements = buildXapiStatements(row, eventsByUser.get(email) || []);
    users.push({
      userEmail: email,
      userName: String(row?.userName || '').trim(),
      role: String(row?.role || 'viewer').trim().toLowerCase(),
      statementCount: statements.length,
      lastStatementAt: statements[0]?.timestamp || '',
      file: `users/${email}.json`
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    users: users.sort((a, b) => b.statementCount - a.statementCount || (Date.parse(b.lastStatementAt || 0) || 0) - (Date.parse(a.lastStatementAt || 0) || 0)),
    statementsByUser: Object.fromEntries(users.map((row) => [row.userEmail, buildXapiStatements(byUser.find((item) => normalizeEmail(item.userEmail) === row.userEmail) || row, eventsByUser.get(row.userEmail) || [])]))
  };
}

async function writeXapiFiles(xapi) {
  const indexUsers = [];
  for (const row of xapi.users || []) {
    const statements = xapi.statementsByUser?.[row.userEmail] || [];
    const payload = {
      generatedAt: xapi.generatedAt,
      actor: buildXapiActor(row),
      statementCount: statements.length,
      statements
    };
    const filePath = path.join(ANALYTICS_XAPI_USERS_DIR, `${row.userEmail}.json`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    indexUsers.push(row);
  }
  await fs.writeFile(ANALYTICS_XAPI_INDEX_PATH, `${JSON.stringify({ generatedAt: xapi.generatedAt, users: indexUsers }, null, 2)}\n`, 'utf8');
}

function buildXapiStatements(userRow, events) {
  return (events || [])
    .map((event) => buildXapiStatement(userRow, event))
    .filter(Boolean)
    .sort((a, b) => (Date.parse(b.timestamp || 0) || 0) - (Date.parse(a.timestamp || 0) || 0));
}

function buildXapiStatement(userRow, event) {
  if (!event) return null;
  const objectId = buildXapiObjectId(event);
  const verb = buildXapiVerb(event);
  return {
    id: `urn:uuid:${sanitizeStatementId(event.eventId)}`,
    actor: buildXapiActor(userRow),
    verb,
    object: {
      id: objectId,
      objectType: 'Activity',
      definition: {
        name: { 'en-US': String(event.title || event.contentId || objectId).trim() },
        type: `https://w3id.org/xapi/video/activity-type/${event.type === 'series' ? 'video' : 'movie'}`,
        extensions: {
          'https://lerna.dev/xapi/extensions/content-id': String(event.contentId || '').trim(),
          'https://lerna.dev/xapi/extensions/imdb-id': String(event.imdbId || '').trim(),
          'https://lerna.dev/xapi/extensions/tmdb-id': String(event.tmdbId || '').trim(),
          'https://lerna.dev/xapi/extensions/episode-key': String(event.episodeKey || '').trim()
        }
      }
    },
    result: {
      completion: Boolean(event.eventType === 'completed' || event.playerStatus === 'completed'),
      success: Boolean(event.eventType === 'completed' || event.playerStatus === 'completed'),
      extensions: {
        'https://lerna.dev/xapi/extensions/progress-value': Number(event.progressValue ?? event.progress ?? 0),
        'https://lerna.dev/xapi/extensions/progress-percent': event.progressPercent == null ? null : Number(event.progressPercent),
        'https://lerna.dev/xapi/extensions/player-status': String(event.playerStatus || '').trim().toLowerCase(),
        'https://lerna.dev/xapi/extensions/event-type': String(event.eventType || '').trim().toLowerCase()
      }
    },
    context: {
      platform: 'Media Evaluation Platform Static',
      contextActivities: {
        category: [{ id: 'https://lerna.dev/xapi/categories/media-analytics' }]
      },
      extensions: {
        'https://lerna.dev/xapi/extensions/season': positiveInteger(event.season, 1),
        'https://lerna.dev/xapi/extensions/episode': positiveInteger(event.episode, 1),
        'https://lerna.dev/xapi/extensions/started-at': String(event.startedAt || '').trim(),
        'https://lerna.dev/xapi/extensions/completed-at': String(event.completedAt || '').trim()
      }
    },
    timestamp: String(event.updatedAt || '').trim(),
    stored: new Date().toISOString()
  };
}

function buildXapiActor(userRow) {
  const email = normalizeEmail(userRow?.userEmail || userRow?.email || '');
  return {
    objectType: 'Agent',
    name: String(userRow?.userName || userRow?.name || email).trim(),
    mbox: `mailto:${email}`
  };
}

function buildXapiVerb(event) {
  const type = String(event?.eventType || '').trim().toLowerCase();
  if (type === 'completed') return { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } };
  if (type === 'started') return { id: 'http://adlnet.gov/expapi/verbs/initialized', display: { 'en-US': 'initialized' } };
  return { id: 'https://w3id.org/xapi/video/verbs/played', display: { 'en-US': 'played' } };
}

function buildXapiObjectId(event) {
  const type = String(event?.type || 'movie').trim().toLowerCase();
  const contentId = String(event?.contentId || event?.imdbId || event?.tmdbId || 'unknown').trim();
  if (type === 'series') {
    return `https://deviltv.local/xapi/series/${contentId}/seasons/${positiveInteger(event?.season, 1)}/episodes/${positiveInteger(event?.episode, 1)}`;
  }
  return `https://deviltv.local/xapi/movie/${contentId}`;
}

function sanitizeStatementId(value) {
  return String(value || 'statement').replace(/[^a-z0-9:-]+/gi, '-').replace(/^-+|-+$/g, '') || 'statement';
}

function sanitizeTelemetryField(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^[A-Za-z]+:\s*/.test(text)) return '';
  return text;
}

function buildEventId(row) {
  const userEmail = normalizeEmail(row?.userEmail || row?.email || '');
  const id = String(row?.contentId || row?.imdbId || row?.tmdbId || '').trim();
  const season = positiveInteger(row?.season, 1);
  const episode = positiveInteger(row?.episode, 1);
  const eventType = String(row?.eventType || row?.playerStatus || 'playing').trim().toLowerCase();
  const updatedAt = String(row?.updatedAt || '').trim();
  return [userEmail || 'unknown', id || 'unknown', `s${season}e${episode}`, eventType || 'event', updatedAt || 'na'].join(':');
}

function inferEventType(playerStatus, progress) {
  const status = String(playerStatus || '').trim().toLowerCase();
  if (status === 'completed') return 'completed';
  if (status === 'playing') return 'started';
  return Number(progress || 0) >= 95 ? 'completed' : 'progress';
}

function roundRatio(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}

function clamp(value, min, max) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
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
