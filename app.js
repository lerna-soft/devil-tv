const state = {
  selected: null,
  seriesEpisodes: null,
  seriesEpisodesLoading: false,
  hydratedProgressId: '',
  remoteResults: [],
  remoteSearchTimer: null,
  searchCommitTimer: null,
  lastRemoteQuery: '',
  isSearching: false,
  playback: { season: 1, episode: 1 },
  playerOpening: false,
  homeSectionView: null,
  playerFallbackTimer: null,
  playerFallbackUrls: [],
  playerEventAt: 0,
  searchIntentId: 0,
  lastCountLabel: '0 items',
  searchingTerm: ''
};
let suppressRouteSync = false;
let episodeIndexPromise = null;
let episodeManifestPromise = null;
let watchProgressHeartbeatStarted = false;
const episodeTextPromises = new Map();
const homeCarouselLastDragAt = new WeakMap();

const AUTH_EMAIL = 'usuario@mail.com';
const ADMIN_EMAIL = 'admin@deviltv.local';
const AUTH_STORAGE_KEY = 'mep_auth_ok';
const AUTH_SESSION_KEY = 'mep_auth_user_v1';
const AUTH_SESSION_LEGACY_KEY = 'mep_auth_user_session_v1';
const AUTH_SALT_PREFIX = 'mep_auth_salt_v1';
const AUTH_LOCAL_USERS_KEY = 'mep_local_auth_users_v1';
const AUTH_USERS_INDEX_PATH = './assets/users/index.json';
const ROLES_INDEX_PATH = './assets/roles/index.json';
const WATCH_PROGRESS_STORAGE_PREFIX = 'mep_watch_progress_';
const WATCH_PROGRESS_LAST_SYNC_PREFIX = 'mep_watch_progress_last_sync_';
const WATCH_PROGRESS_SYNC_LABEL = 'watch-progress-sync';
const TITLE_PREFS_STORAGE_PREFIX = 'mep_title_prefs_';
const EVAL_STORAGE_KEY = 'mep_evaluations_v1';
const GITHUB_ISSUE_TOKEN_SEED = 'mep_issue_token_key_v1';
const GITHUB_ISSUE_TOKEN_CIPHER = 'CgwENxwRLAUEKyteWic8ESY2Nx5GaCIzKToYIyUSJzIRMAFXPiZaDhgqHWIZIENmPB8HMzJvOCEnMxwUIjcrGw8AXQ0gFwsJAQRVKxslOy4mDD8wTRwMUDgXSSY+';
const TMDB_READ_TOKEN_SEED = 'mep_tmdb_token_key_v1';
const TMDB_READ_TOKEN_CIPHER = 'CBw6NxYqBwsQHSUiMBQWWisQFU8fCBw6NxA6NQsQHSUCPzo0EiouFR1+OiMaEhkoVTsIJRgmMSw3MTE/MzsDIwg9bSVZKggWRCICLB0WBlAQBR94WygkPEciICcmOysiVSA2X1c2GydCJAs+bi0ELVQWHjZePwMSEystPERoOScbETMgHDsIPgcxDyg2JiI0JzhIJBY5MToHBlEdGAwSLFgIEi8RPDFdCwYdCRw3Jyg7OCwhVzQHIR8YCE9EJA8fJxI8SiU4GSUbXCI9XiEobwxEGVAZLBcHAFppBAAsMDkRBFxACB1mOBEkGTECICc=';
const TMDB_META_CACHE_KEY = 'mep_tmdb_meta_cache_v1';
const TMDB_ALERT_LABEL = 'tmdb-token-alert';
const TMDB_ALERT_DEDUPE_PREFIX = 'mep_tmdb_alert_once_';
const SEED_SYNC_LABEL = 'catalog-seed-sync';
const SEED_SYNC_DEDUPE_PREFIX = 'mep_seed_sync_once_';
const SEED_CATALOG_KEYS_STORAGE = 'mep_seed_catalog_keys_v1';
const SEED_SYNC_WINDOW_MS = 12 * 60 * 60 * 1000;
const WATCH_PROGRESS_HEARTBEAT_MS = 30 * 1000;
const WATCH_PROGRESS_HEARTBEAT_LOCK_KEY = 'mep_watch_progress_queue_heartbeat_lock_v1';
const WATCH_PROGRESS_HEARTBEAT_DISPATCH_KEY = 'mep_watch_progress_queue_heartbeat_last_dispatch_v1';
const WATCH_PROGRESS_HEARTBEAT_DISPATCH_WINDOW_MS = 2 * 60 * 1000;
const EPISODE_MANIFEST_CACHE_KEY = 'mep_episode_manifest_v1';
const EPISODE_MANIFEST_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const PLAYER_FALLBACK_DELAY_MS = 6500;
const HOME_STREAMING_GROUPS = [
  { key: 'netflix', label: 'Netflix', aliases: ['netflix'] },
  { key: 'primevideo', label: 'Prime Video', aliases: ['primevideo', 'amazonprimevideo', 'primevideoamazonchannel'] },
  { key: 'disneyplus', label: 'Disney+', aliases: ['disneyplus', 'disneynow'] },
  { key: 'max', label: 'Max', aliases: ['max', 'hbomax', 'hbo'] },
  { key: 'hulu', label: 'Hulu', aliases: ['hulu'] },
  { key: 'appletvplus', label: 'Apple TV+', aliases: ['appletvplus', 'appletv', 'appletvstore', 'appletvamazonchannel'] },
  { key: 'paramountplus', label: 'Paramount+', aliases: ['paramountplus', 'paramountplusappletvchannel'] }
];

const elements = {
  search: document.querySelector('#search'),
  typeFilter: document.querySelector('#typeFilter'),
  genreFilter: document.querySelector('#genreFilter'),
  sortFilter: document.querySelector('#sortFilter'),
  logoutBtn: document.querySelector('#logoutBtn'),
  appShell: document.querySelector('#appShell'),
  userChip: document.querySelector('#userChip'),
  userAvatar: document.querySelector('#userAvatar'),
  userName: document.querySelector('#userName'),
  userEmail: document.querySelector('#userEmail'),
  tabs: document.querySelectorAll('[data-type-tab]'),
  items: document.querySelector('#items'),
  count: document.querySelector('#count'),
  detail: document.querySelector('#detail'),
  playerModal: document.querySelector('#playerModal'),
  playerIframe: document.querySelector('#player'),
  playerControls: document.querySelector('#playerControls'),
  authGate: document.querySelector('#authGate'),
  authFormLogin: document.querySelector('#authFormLogin'),
  authEmailLogin: document.querySelector('#authEmailLogin'),
  authPasswordLogin: document.querySelector('#authPasswordLogin'),
  authErrorLogin: document.querySelector('#authErrorLogin'),
  authSubmitLogin: document.querySelector('#authSubmitLogin'),
  authToggleLogin: document.querySelector('#authToggleLogin'),
  authFormRegister: document.querySelector('#authFormRegister'),
  authNameRegister: document.querySelector('#authNameRegister'),
  authEmailRegister: document.querySelector('#authEmailRegister'),
  authPasswordRegister: document.querySelector('#authPasswordRegister'),
  authPasswordConfirmRegister: document.querySelector('#authPasswordConfirmRegister'),
  authErrorRegister: document.querySelector('#authErrorRegister'),
  authSubmitRegister: document.querySelector('#authSubmitRegister'),
  authToggleRegister: document.querySelector('#authToggleRegister'),
  loginCard: document.querySelector('#loginCard'),
  registerCard: document.querySelector('#registerCard')
};

let authMode = 'login';

function isAuthenticated() {
  return localStorage.getItem(AUTH_STORAGE_KEY) === '1';
}

function loadAuthSession() {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_KEY) || sessionStorage.getItem(AUTH_SESSION_KEY) || localStorage.getItem(AUTH_SESSION_LEGACY_KEY) || 'null';
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveAuthSession(user) {
  if (!user) {
    localStorage.removeItem(AUTH_SESSION_KEY);
    sessionStorage.removeItem(AUTH_SESSION_KEY);
    localStorage.removeItem(AUTH_SESSION_LEGACY_KEY);
    return;
  }
  const payload = JSON.stringify({
    email: String(user.email || '').trim().toLowerCase(),
    name: String(user.name || '').trim(),
    role: String(user.role || '').trim().toLowerCase()
  });
  localStorage.setItem(AUTH_SESSION_KEY, payload);
  sessionStorage.setItem(AUTH_SESSION_KEY, payload);
}

function getAuthUser() {
  const session = loadAuthSession();
  const email = String(session?.email || '').trim().toLowerCase();
  if (!email) return null;
  return {
    email,
    name: String(session?.name || '').trim(),
    role: String(session?.role || '').trim().toLowerCase()
  };
}

function isAdminUser(user = getAuthUser()) {
  const email = String(user?.email || '').trim().toLowerCase();
  const role = String(user?.role || '').trim().toLowerCase();
  return role === 'admin' || email === ADMIN_EMAIL;
}

function getInitials(name, email) {
  const source = String(name || '').trim() || String(email || '').split('@')[0] || 'U';
  const parts = source.replace(/[^a-z0-9]+/gi, ' ').trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase());
  return (letters.join('') || source.slice(0, 2).toUpperCase() || 'U').slice(0, 2);
}

function showAuthGate() {
  if (!elements.authGate) return;
  elements.authGate.hidden = false;
  syncAuthModeUi();
  window.setTimeout(() => {
    if (authMode === 'register') elements.authNameRegister?.focus();
    else elements.authEmailLogin?.focus();
  }, 0);
}

function hideAuthGate() {
  if (!elements.authGate) return;
  elements.authGate.hidden = true;
}

function bindAuth() {
  if (!elements.authFormLogin || !elements.authFormRegister) return;

  syncAuthModeUi();

  elements.authToggleLogin?.addEventListener('click', () => {
    authMode = authMode === 'login' ? 'register' : 'login';
    syncAuthModeUi();
    if (authMode === 'register') elements.authNameRegister?.focus();
    else elements.authEmailLogin?.focus();
  });

  elements.authToggleRegister?.addEventListener('click', () => {
    authMode = 'login';
    syncAuthModeUi();
    elements.authEmailLogin?.focus();
  });

  elements.authFormLogin.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = String(elements.authEmailLogin.value || '').trim().toLowerCase();
    const password = String(elements.authPasswordLogin.value || '');
    const validated = await validateAuthUser(email, password);
    if (validated.ok) {
      localStorage.setItem(AUTH_STORAGE_KEY, '1');
      saveAuthSession(validated.user);
      hideAuthGate();
      updateAuthUi();
      startWatchProgressQueueHeartbeat();
      void hydrateWatchProgressForCurrentUser();
      renderCatalog();
      return;
    }
    if (elements.authErrorLogin) elements.authErrorLogin.textContent = validated.error || 'Credenciales incorrectas.';
  });

  elements.authFormRegister.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = String(elements.authNameRegister.value || '').trim();
    const email = String(elements.authEmailRegister.value || '').trim().toLowerCase();
    const password = String(elements.authPasswordRegister.value || '');
    const confirmPassword = String(elements.authPasswordConfirmRegister.value || '');

    if (!name || !email || !password || !confirmPassword) {
      if (elements.authErrorRegister) elements.authErrorRegister.textContent = 'Completa todos los campos.';
      return;
    }
    if (password !== confirmPassword) {
      if (elements.authErrorRegister) elements.authErrorRegister.textContent = 'Las contraseñas no coinciden.';
      return;
    }
    const created = await registerAuthUser({ name, email, password });
    if (!created.ok) {
      if (elements.authErrorRegister) elements.authErrorRegister.textContent = created.error || 'No se pudo crear la cuenta.';
      return;
    }
    if (elements.authErrorRegister) elements.authErrorRegister.textContent = '';
    localStorage.setItem(AUTH_STORAGE_KEY, '1');
    saveAuthSession(created.user || { name, email, role: 'viewer' });
    hideAuthGate();
    updateAuthUi();
    startWatchProgressQueueHeartbeat();
    void hydrateWatchProgressForCurrentUser();
    renderCatalog();
    renderDetail({ skipHydratePlayback: true });
  });

  elements.logoutBtn?.addEventListener('click', () => {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    saveAuthSession(null);
    authMode = 'login';
    state.selected = null;
    state.seriesEpisodes = null;
    closePlayerModal();
    hideAuthGate();
    updateAuthUi();
    showAuthGate();
    renderCatalog();
    renderDetail();
  });
}

bindAuth();

function syncAuthModeUi() {
  const isRegister = authMode === 'register';
  if (elements.loginCard) {
    elements.loginCard.hidden = isRegister;
    elements.loginCard.setAttribute('aria-hidden', isRegister ? 'true' : 'false');
  }
  if (elements.registerCard) {
    elements.registerCard.hidden = !isRegister;
    elements.registerCard.setAttribute('aria-hidden', isRegister ? 'false' : 'true');
  }
  if (elements.authErrorLogin) elements.authErrorLogin.textContent = '';
  if (elements.authErrorRegister) elements.authErrorRegister.textContent = '';
}

function makeSalt() {
  return `${AUTH_SALT_PREFIX}_${cryptoRandomHex(8)}`;
}

function cryptoRandomHex(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function registerAuthUser({ name, email, password }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!name || !normalizedEmail || !password) return { ok: false, error: 'Completa todos los campos.' };
  const salt = makeSalt();
  const passwordHash = await hashPassword(password, salt);
  const existing = await loadUserRecord(normalizedEmail).catch(() => null);
  const localUsers = loadLocalAuthUsers();
  if (existing || localUsers[normalizedEmail]) return { ok: false, error: 'Ese correo ya existe.' };

  localUsers[normalizedEmail] = {
    name,
    email: normalizedEmail,
    role: 'viewer',
    salt,
    passwordHash,
    pendingSync: true,
    createdAt: new Date().toISOString()
  };
  saveLocalAuthUsers(localUsers);

  void enqueueUserRegisterIssue({ name, email: normalizedEmail, salt, passwordHash });
  return { ok: true, user: { name, email: normalizedEmail, role: 'viewer' } };
}

async function validateAuthUser(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = await loadUserRecord(normalizedEmail).catch(() => null);
  if (user) {
    const candidate = await hashPassword(password, String(user.salt || ''));
    if (candidate === user.passwordHash) {
      markLocalUserAsSynced(normalizedEmail, user);
      return { ok: true, user };
    }
  }

  const localUsers = loadLocalAuthUsers();
  const localUser = localUsers[normalizedEmail];
  if (!localUser) return { ok: false, error: 'Credenciales incorrectas.' };
  const candidate = await hashPassword(password, String(localUser.salt || ''));
  if (candidate !== localUser.passwordHash) return { ok: false, error: 'Credenciales incorrectas.' };
  return { ok: true, user: { name: localUser.name, email: normalizedEmail, role: localUser.role || 'viewer' } };
}

function loadLocalAuthUsers() {
  try {
    const data = JSON.parse(localStorage.getItem(AUTH_LOCAL_USERS_KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveLocalAuthUsers(users) {
  try {
    localStorage.setItem(AUTH_LOCAL_USERS_KEY, JSON.stringify(users || {}));
  } catch {}
}

function markLocalUserAsSynced(email, remoteUser) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return;
  const users = loadLocalAuthUsers();
  if (!users[key]) return;
  users[key] = {
    ...users[key],
    name: String(remoteUser?.name || users[key].name || '').trim(),
    role: String(remoteUser?.role || users[key].role || 'viewer').trim().toLowerCase(),
    pendingSync: false,
    syncedAt: new Date().toISOString()
  };
  saveLocalAuthUsers(users);
}

async function enqueueUserRegisterIssue({ name, email, salt, passwordHash }) {
  try {
    await openGitHubIssue(
      `User registration: ${name} <${email}>`,
      buildUserRegistrationBody({ name, email, salt, passwordHash, role: 'viewer' }),
      ['user-register']
    );
  } catch {
    // keep local user usable even if remote sync fails for now
  }
}

function loadLocalWatchProgress(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  try {
    return JSON.parse(localStorage.getItem(`${WATCH_PROGRESS_STORAGE_PREFIX}${normalizedEmail}`) || 'null');
  } catch {
    return null;
  }
}

function saveLocalWatchProgress(email, progress) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return;
  try {
    localStorage.setItem(`${WATCH_PROGRESS_STORAGE_PREFIX}${normalizedEmail}`, JSON.stringify(progress || {}));
  } catch {
    // ignore storage write issues
  }
}

async function loadRemoteWatchProgress(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  const cacheTag = window.__mep_build || Date.now();
  const primary = await fetchJsonWithTimeout(`./assets/watch-progress/users/${encodeURIComponent(normalizedEmail)}/data.json?v=${cacheTag}`).catch(() => null);
  return primary?.email ? primary : null;
}

async function hydrateWatchProgressForCurrentUser() {
  const user = getAuthUser();
  if (!user?.email) return;
  const remote = await loadRemoteWatchProgress(user.email);
  if (!remote) return;
  mergeRemoteWatchProgress(remote);
  renderCatalog();
  renderDetail({ skipHydratePlayback: true });
}

function mergeRemoteWatchProgress(remote) {
  const email = String(remote?.email || '').trim().toLowerCase();
  if (!email) return;
  const remoteProgress = remote?.progress && typeof remote.progress === 'object' ? remote.progress : {};
  const existing = loadLocalWatchProgress(email) || {};
  const merged = {
    email,
    name: String(remote?.name || existing.name || '').trim(),
    updatedAt: maxIsoString(existing.updatedAt, remote.updatedAt),
    progress: mergeProgressMaps(existing.progress || {}, remoteProgress),
    lastWatch: pickNewestByUpdatedAt(existing.lastWatch, remote.lastWatch),
    lastSelection: pickNewestByUpdatedAt(existing.lastSelection, remote.lastSelection),
    history: mergeWatchHistory(existing.history || [], remote.history || [])
  };
  saveLocalWatchProgress(email, merged);
  syncTitlePrefsFromRemote(remote?.preferences || null);
  ensureCatalogEntriesFromWatchData(merged);
}

function syncTitlePrefsFromRemote(remotePrefs) {
  const key = getCurrentUserPrefsKey();
  if (!key || !remotePrefs || typeof remotePrefs !== 'object') return;

  const localRaw = safeJson(localStorage.getItem(key)) || {};
  const localUpdatedAt = Date.parse(localRaw?.updatedAt || 0) || 0;
  const remoteUpdatedAt = Date.parse(remotePrefs?.updatedAt || 0) || 0;

  if (remoteUpdatedAt > 0 && localUpdatedAt > remoteUpdatedAt) return;

  const likes = remotePrefs?.likes && typeof remotePrefs.likes === 'object' ? remotePrefs.likes : {};
  const watchLater = remotePrefs?.watchLater && typeof remotePrefs.watchLater === 'object' ? remotePrefs.watchLater : {};

  localStorage.setItem(key, JSON.stringify({
    likes,
    watchLater,
    updatedAt: remotePrefs?.updatedAt || new Date().toISOString()
  }));
}

function mergeProgressMaps(existing, incoming) {
  const out = { ...(existing || {}) };
  for (const [titleId, progress] of Object.entries(incoming || {})) {
    out[titleId] = mergeProgressEntry(out[titleId], progress);
  }
  return out;
}

function mergeProgressEntry(existing, incoming) {
  if (!incoming || typeof incoming !== 'object') return existing || null;
  if (!existing || typeof existing !== 'object') return { ...incoming };
  const existingUpdated = Date.parse(existing.updatedAt || 0) || 0;
  const incomingUpdated = Date.parse(incoming.updatedAt || 0) || 0;
  if (incomingUpdated > existingUpdated) return { ...existing, ...incoming };
  if (incomingUpdated < existingUpdated) return existing;
  return {
    ...existing,
    ...incoming,
    watched: { ...(existing.watched || {}), ...(incoming.watched || {}) }
  };
}

function loadSyncedWatchProgress(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  try {
    return JSON.parse(localStorage.getItem(`${WATCH_PROGRESS_STORAGE_PREFIX}${normalizedEmail}`) || 'null');
  } catch {
    return null;
  }
}

function mergeWatchHistory(existing, incoming) {
  const rows = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]
    .filter((entry) => entry && typeof entry === 'object');
  const map = new Map();
  for (const row of rows) {
    const id = String(row.imdbId || row.tmdbId || '').trim();
    const season = positiveInteger(row.season, 1);
    const episode = positiveInteger(row.episode, 1);
    const status = String(row.playerStatus || '').trim().toLowerCase();
    const at = String(row.updatedAt || row.watchedAt || '').trim();
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
      playerStatus: status || 'playing',
      updatedAt: at
    });
  }
  return [...map.values()]
    .sort((a, b) => (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0))
    .slice(0, 500);
}

function ensureCatalogEntriesFromWatchData(watchData) {
  const current = loadLocalCatalog();
  const additions = [];
  const hasById = (imdbId, tmdbId) => current.some((entry) =>
    (imdbId && String(entry.imdbId || '').trim() === imdbId) || (tmdbId && String(entry.tmdbId || '').trim() === tmdbId)
  );
  const history = Array.isArray(watchData?.history) ? watchData.history : [];
  for (const item of history) {
    const imdbId = String(item?.imdbId || '').trim();
    const tmdbId = String(item?.tmdbId || '').trim();
    const id = imdbId || tmdbId;
    if (!id || hasById(imdbId, tmdbId)) continue;
    additions.push({
      catalogKey: `${String(item?.type || 'movie').trim() || 'movie'}:${imdbId ? 'imdb' : 'tmdb'}:${id}`,
      type: String(item?.type || 'movie').trim() || 'movie',
      imdbId,
      tmdbId,
      title: String(item?.title || id).trim(),
      year: null,
      description: 'Sincronizado desde historial',
      posterUrl: '',
      playable: true,
      metadata: { releaseDate: null, genres: [], backdropUrl: null, watchProviders: { region: '', flatrate: [] } }
    });
  }
  if (additions.length > 0) saveLocalCatalog(dedupe([...current, ...additions], { consolidateEquivalent: true }));
}

function persistSyncedWatchSnapshot(kind, snapshot) {
  const user = getAuthUser();
  if (!user?.email) return;
  const current = loadSyncedWatchProgress(user.email) || {
    email: user.email,
    name: user.name,
    progress: {}
  };
  const updatedAt = new Date().toISOString();
  const merged = {
    ...current,
    email: user.email,
    name: user.name || current.name || '',
    updatedAt
  };
  if (kind === 'progress') {
    const titleId = String(snapshot?.imdbId || snapshot?.tmdbId || '').trim();
    if (titleId) {
      merged.progress = {
        ...(current.progress || {}),
        [titleId]: {
          ...(current.progress?.[titleId] || {}),
          imdbId: String(snapshot?.imdbId || '').trim(),
          tmdbId: String(snapshot?.tmdbId || '').trim(),
          lastSeason: positiveInteger(snapshot?.season, 1),
          lastEpisode: positiveInteger(snapshot?.episode, 1),
          lastProgress: Number(snapshot?.progress || 0),
          updatedAt
        }
      };
      merged.lastWatch = {
        imdbId: String(snapshot?.imdbId || '').trim(),
        tmdbId: String(snapshot?.tmdbId || '').trim(),
        season: positiveInteger(snapshot?.season, 1),
        episode: positiveInteger(snapshot?.episode, 1),
        progress: Number(snapshot?.progress || 0),
        updatedAt
      };
    }
    const event = {
      imdbId: String(snapshot?.imdbId || '').trim(),
      tmdbId: String(snapshot?.tmdbId || '').trim(),
      title: String(state.selected?.title || '').trim(),
      type: String(state.selected?.type || '').trim(),
      season: positiveInteger(snapshot?.season, 1),
      episode: positiveInteger(snapshot?.episode, 1),
      progress: Number(snapshot?.progress || 0),
      playerStatus: String(snapshot?.player_status || 'playing').trim().toLowerCase(),
      updatedAt
    };
    merged.history = mergeWatchHistory(current.history || [], [event]);
  }
  if (kind === 'lastSelection') {
    merged.lastSelection = {
      ...snapshot,
      updatedAt
    };
  }
  saveLocalWatchProgress(user.email, merged);
}

function pickNewestByUpdatedAt(existing, incoming) {
  if (!existing) return incoming || null;
  if (!incoming) return existing || null;
  const existingUpdated = Date.parse(existing.updatedAt || 0) || 0;
  const incomingUpdated = Date.parse(incoming.updatedAt || 0) || 0;
  return incomingUpdated >= existingUpdated ? incoming : existing;
}

function maxIsoString(a, b) {
  const at = Date.parse(a || 0) || 0;
  const bt = Date.parse(b || 0) || 0;
  return bt >= at ? (b || a || '') : (a || b || '');
}

function buildUserRegistrationBody({ name, email, salt, passwordHash, role = 'viewer' }) {
  return [
    'USER_REGISTRATION_REQUEST',
    `Name: ${name}`,
    `Email: ${email}`,
    `Role: ${String(role || 'viewer').trim().toLowerCase()}`,
    `Salt: ${salt}`,
    `PasswordHash: ${passwordHash}`,
    '',
    `File: assets/users/${email}.json`
  ].join('\n');
}

async function createAgentByAdmin({ name, email, password }) {
  if (!isAdminUser()) return { ok: false, error: 'Solo administrador.' };
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const safeName = String(name || '').trim();
  const safePassword = String(password || '');
  if (!safeName || !normalizedEmail || !safePassword) return { ok: false, error: 'Completa todos los campos.' };
  const existing = await loadUserRecord(normalizedEmail).catch(() => null);
  if (existing) return { ok: false, error: 'Ese correo ya existe.' };
  const salt = makeSalt();
  const passwordHash = await hashPassword(safePassword, salt);
  const body = [
    'ROLE_PROVISION_REQUEST',
    `Action: create_agent`,
    `Name: ${safeName}`,
    `Email: ${normalizedEmail}`,
    'Role: agent',
    `Salt: ${salt}`,
    `PasswordHash: ${passwordHash}`,
    `RequestedBy: ${String(getAuthUser()?.email || '').trim().toLowerCase()}`,
    `RequestedAt: ${new Date().toISOString()}`
  ].join('\n');
  const issue = await openGitHubIssue(`Role provision: agent ${safeName} <${normalizedEmail}>`, body, ['role-provision']);
  return { ok: true, issue };
}

async function loadUserRecord(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  const index = await fetchJsonWithTimeout(`${AUTH_USERS_INDEX_PATH}?v=${window.__mep_build || Date.now()}`);
  const entry = Array.isArray(index?.users)
    ? index.users.find((item) => String(item.email || '').toLowerCase() === normalizedEmail)
    : null;
  const file = String(entry?.file || `${normalizedEmail}.json`);
  const record = await fetchJsonWithTimeout(`./assets/users/${encodeURIComponent(file)}?v=${window.__mep_build || Date.now()}`);
  if (!record?.email) return null;
  return {
    ...record,
    role: String(record?.role || 'viewer').trim().toLowerCase() || 'viewer'
  };
}

async function fetchJsonWithTimeout(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`Failed to load ${url}`);
    return response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

elements.search.addEventListener('input', () => {
  state.searchIntentId += 1;
  state.searchingTerm = elements.search.value.trim();
  if (elements.search.value.trim().length > 0) {
    state.homeSectionView = null;
    state.isSearching = true;
    setCatalogCount(state.lastCountLabel || '0 items');
  }
  scheduleSearchCommit();
});
elements.typeFilter.addEventListener('change', () => {
  state.searchIntentId += 1;
  state.homeSectionView = null;
  syncTabs(elements.typeFilter.value);
  renderCatalog();
  scheduleRemoteSearch();
});
elements.genreFilter?.addEventListener('change', () => {
  state.searchIntentId += 1;
  state.homeSectionView = null;
  renderCatalog();
  scheduleRemoteSearch();
});
elements.sortFilter?.addEventListener('change', () => {
  if (elements.search.value.trim().length > 0) state.homeSectionView = null;
  renderCatalog();
  if (state.remoteResults.length > 0 && elements.search.value.trim().length >= 3) {
    renderRemoteResults(elements.search.value.trim());
  }
});
elements.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const nextType = tab.dataset.typeTab;
    if (nextType === 'all') {
      clearTimeout(state.remoteSearchTimer);
      clearTimeout(state.searchCommitTimer);
      state.homeSectionView = null;
      state.remoteResults = [];
      state.lastRemoteQuery = '';
      state.isSearching = false;
      elements.search.value = '';
      elements.typeFilter.value = 'all';
      if (elements.genreFilter) elements.genreFilter.value = 'all';
      if (elements.sortFilter) elements.sortFilter.value = 'relevance';
      syncTabs('all');
      state.selected = null;
      state.seriesEpisodes = null;
      closePlayerModal();
      renderCatalog();
      renderDetail();
      syncRoute();
      return;
    }

    state.homeSectionView = null;
    elements.typeFilter.value = nextType;
    syncTabs(nextType);
    renderCatalog();
    scheduleRemoteSearch();
  });
});

window.addEventListener('hashchange', handleRouteChange);
bindPlayerModalEvents();
handleRouteChange();
hydrateSeedCatalog().then(() => renderCatalog()).catch(() => {});

if (isAuthenticated()) hideAuthGate();
else showAuthGate();

function getTmdbReadToken() {
  return decodeIssueToken(TMDB_READ_TOKEN_CIPHER, TMDB_READ_TOKEN_SEED);
}

async function reportTmdbAlertOnce(code, detail) {
  const dedupeKey = `${TMDB_ALERT_DEDUPE_PREFIX}${String(code || 'unknown')}`;
  if (sessionStorage.getItem(dedupeKey) === '1') return;
  sessionStorage.setItem(dedupeKey, '1');
  try {
    const user = getAuthUser();
    await openGitHubIssue(
      `TMDB alert: ${String(code || 'unknown')}`,
      [
        'TMDB_TOKEN_ALERT',
        `Code: ${String(code || '').trim()}`,
        `Detail: ${String(detail || '').trim()}`,
        `User: ${String(user?.email || 'anonymous').trim()}`,
        `Page: ${window.location.href}`,
        `CreatedAt: ${new Date().toISOString()}`
      ].join('\n'),
      [TMDB_ALERT_LABEL]
    );
  } catch {
    // no-op: alerting should not block playback/catalog
  }
}

async function tmdbFetchJson(path, params) {
  const token = getTmdbReadToken();
  if (!token) {
    await reportTmdbAlertOnce('missing_tmdb_token', `path=${String(path || '').trim()}`);
    throw new Error('missing TMDB read token');
  }
  const url = new URL(`https://api.themoviedb.org/3/${String(path).replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`
    }
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      await reportTmdbAlertOnce('tmdb_auth_error', `${res.status} on ${url.pathname}`);
    }
    throw new Error(`tmdb ${res.status}`);
  }
  return res.json();
}

function loadTmdbMetaCache() {
  try { return JSON.parse(localStorage.getItem(TMDB_META_CACHE_KEY) || '{}'); } catch { return {}; }
}

function saveTmdbMetaCache(cache) {
  try { localStorage.setItem(TMDB_META_CACHE_KEY, JSON.stringify(cache || {})); } catch {}
}

function getMetaCacheKey(title) {
  const id = title?.imdbId || title?.tmdbId || '';
  return `${title?.type || 'unknown'}:${id}`;
}

async function hydrateSelectedFromTmdb() {
  const title = state.selected;
  if (!title) return;
  if (!title.imdbId && !title.tmdbId) return;

  const token = getTmdbReadToken();
  if (!token) return;

  const cache = loadTmdbMetaCache();
  const key = getMetaCacheKey(title);
  const cached = cache[key];
  if (cached && cached.payload) {
    Object.assign(title, cached.payload);
    return;
  }

  try {
    let tmdbType = title.type === 'series' ? 'tv' : 'movie';
    let tmdbId = title.tmdbId ? String(title.tmdbId) : '';

    if (!tmdbId && title.imdbId) {
      const found = await tmdbFetchJson(`/find/${encodeURIComponent(title.imdbId)}`, { external_source: 'imdb_id', language: 'es-ES' });
      const pick = tmdbType === 'tv' ? (found.tv_results?.[0] || null) : (found.movie_results?.[0] || null);
      if (pick?.id) tmdbId = String(pick.id);
      if (pick?.poster_path && !title.posterUrl) title.posterUrl = `https://image.tmdb.org/t/p/w500${pick.poster_path}`;
      if (pick?.overview && (!title.description || title.description === 'IMDb result')) title.description = pick.overview;
    }

    if (!tmdbId) return;

    const details = await tmdbFetchJson(`/${tmdbType}/${encodeURIComponent(tmdbId)}`, { language: 'es-ES' });
    const credits = await tmdbFetchJson(`/${tmdbType}/${encodeURIComponent(tmdbId)}/credits`, { language: 'es-ES' });

    const genres = (details.genres || []).map((g) => g.name).filter(Boolean);
    const castNames = (credits.cast || []).slice(0, 10).map((c) => c.name).filter(Boolean);
    const endYear = tmdbType === 'tv' && details.last_air_date ? String(details.last_air_date).slice(0, 4) : '';
    const backdropUrl = details.backdrop_path ? `https://image.tmdb.org/t/p/w780${details.backdrop_path}` : '';
    const posterUrl = details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : '';

    const payload = {
      tmdbId,
      title: title.title || details.name || details.title || title.title,
      year: title.year || Number(String((details.first_air_date || details.release_date || '')).slice(0, 4)) || title.year,
      description: details.overview || title.description,
      posterUrl: title.posterUrl || posterUrl,
      metadata: {
        ...(title.metadata || {}),
        genres,
        cast: castNames,
        endYear: endYear || (title.metadata?.endYear ?? ''),
        backdropUrl: backdropUrl || (title.metadata?.backdropUrl ?? null)
      }
    };

    Object.assign(title, payload);
    cache[key] = { cachedAt: Date.now(), payload };
    saveTmdbMetaCache(cache);
  } catch {
    // Ignore TMDB failures; keep existing metadata.
  }
}

function updateAuthUi() {
  const authenticated = isAuthenticated();
  const session = loadAuthSession();
  if (elements.appShell) elements.appShell.hidden = !authenticated;
  if (elements.userChip) {
    elements.userChip.hidden = !authenticated;
    elements.userChip.setAttribute('aria-hidden', authenticated ? 'false' : 'true');
  }
  if (elements.logoutBtn) {
    elements.logoutBtn.textContent = authenticated ? 'Logout' : 'Login';
    elements.logoutBtn.title = authenticated ? 'Cerrar sesión' : 'Iniciar sesión';
  }
  if (authenticated) {
    const name = String(session?.name || '').trim() || 'Usuario';
    const email = String(session?.email || '').trim();
    const admin = isAdminUser(session);
    document.body.classList.toggle('admin-mode', admin);
    if (elements.userName) elements.userName.textContent = name;
    if (elements.userEmail) elements.userEmail.textContent = admin ? `${email} · admin` : email;
    if (elements.userAvatar) elements.userAvatar.textContent = getInitials(name, email);
  } else {
    document.body.classList.remove('admin-mode');
    if (elements.userName) elements.userName.textContent = '';
    if (elements.userEmail) elements.userEmail.textContent = '';
    if (elements.userAvatar) elements.userAvatar.textContent = '';
    if (elements.appShell) elements.appShell.hidden = true;
  }
}

updateAuthUi();
startWatchProgressQueueHeartbeat();
hydrateWatchProgressForCurrentUser().catch(() => {});

async function hydrateSeedCatalog() {
  const seedUrl = `./assets/catalog.seed.json?v=${window.__mep_build || ''}`;
  const response = await fetch(seedUrl, { cache: 'no-store' }).catch(() => null);
  if (!response?.ok) return;
  const seed = await response.json().catch(() => null);
  if (!seed || (!Array.isArray(seed.movies) && !Array.isArray(seed.series))) return;

  const seedVersion = Number(seed.version || 0);
  const appliedVersion = Number(localStorage.getItem('mep_seed_version') || '0');
  if (seedVersion && appliedVersion === seedVersion) return;

  const items = [];
  for (const entry of seed.movies ?? []) {
    items.push(normalizeSeedEntry(entry, 'movie'));
  }
  for (const entry of seed.series ?? []) {
    items.push(normalizeSeedEntry(entry, 'series'));
  }
  try {
    const keys = dedupe(items, { consolidateEquivalent: true })
      .map((entry) => getSeedSyncKey(entry))
      .filter(Boolean);
    localStorage.setItem(SEED_CATALOG_KEYS_STORAGE, JSON.stringify(keys));
  } catch {}

  const current = loadLocalCatalog();
  const merged = dedupe([...current, ...items]);
  saveLocalCatalog(merged);
  if (seedVersion) localStorage.setItem('mep_seed_version', String(seedVersion));
}

function normalizeSeedEntry(entry, defaultType) {
  const type = entry?.type || defaultType;
  const tmdbId = entry?.tmdbId ? String(entry.tmdbId) : '';
  const imdbId = entry?.imdbId ? String(entry.imdbId) : '';
  const id = imdbId || tmdbId;
  const title = entry?.title || '';
  const year = Number(entry?.year) || null;
  const description = entry?.overview || entry?.description || '';
  const posterUrl = entry?.posterUrl || '';
  const playable = type === 'series' ? (entry?.playable ?? true) : true;
  return {
    catalogKey: `${type}:${imdbId ? 'imdb' : 'tmdb'}:${id}`,
    type,
    imdbId,
    tmdbId,
    title,
    year,
    description,
    posterUrl,
    playable,
    metadata: {
      releaseDate: entry?.releaseDate || null,
      genres: entry?.genres || [],
      backdropUrl: entry?.backdropUrl || null,
      watchProviders: {
        region: entry?.watchProviders?.region || '',
        flatrate: Array.isArray(entry?.watchProviders?.flatrate) ? entry.watchProviders.flatrate : []
      }
    }
  };
}

function normalizePlatformKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function titleHasProvider(title, providerKeyOrAliases) {
  const providers = Array.isArray(title?.metadata?.watchProviders?.flatrate)
    ? title.metadata.watchProviders.flatrate
    : [];
  const aliases = Array.isArray(providerKeyOrAliases) ? providerKeyOrAliases : [providerKeyOrAliases];
  const normalizedAliases = aliases.map((alias) => normalizePlatformKey(alias)).filter(Boolean);
  return providers.some((name) => {
    const normalized = normalizePlatformKey(name);
    return normalizedAliases.some((alias) => normalized.includes(alias));
  });
}

function loadEvaluations() {
  try { return JSON.parse(localStorage.getItem(EVAL_STORAGE_KEY) || '{}'); } catch { return {}; }
}

function saveEvaluations(evals) {
  localStorage.setItem(EVAL_STORAGE_KEY, JSON.stringify(evals || {}));
}

function getPlaybackTitleKey(entry) {
  return String(entry?.imdbId || entry?.tmdbId || '').trim();
}

function getTitleId(title) {
  return title?.imdbId || title?.tmdbId || title?.catalogKey || '';
}

function hash32(input) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pseudoRandom01(seed) {
  // xorshift32
  let x = seed >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return ((x >>> 0) % 10000) / 10000;
}

function getSyntheticStats(title) {
  const id = getTitleId(title);
  const seed = hash32(String(id || title?.title || 'mep'));
  const r1 = pseudoRandom01(seed);
  const r2 = pseudoRandom01(seed ^ 0x9e3779b9);
  const votes = 120 + Math.floor(r1 * 9800);
  const rating = Math.round((5.4 + r2 * 3.9) * 10) / 10;
  return { votes, rating };
}

function renderEvaluationPanel(title) {
  const id = getTitleId(title);
  const evals = loadEvaluations();
  const current = evals[id] || {};
  const stats = getSyntheticStats(title);
  const myVote = Number(current.vote) || '';
  const myComment = String(current.comment || '');

  return `<section class="eval-panel">
    <h3>Evaluación</h3>
    <div class="eval-stats">
      <span class="eval-chip">Calificación: <strong>${stats.rating}</strong></span>
      <span class="eval-chip">Votos: <strong>${stats.votes}</strong></span>
    </div>
    <div class="eval-form">
      <label class="eval-field">
        <span>Tu voto (1-10)</span>
        <input id="evalVote" type="number" min="1" max="10" step="1" value="${escapeAttribute(String(myVote))}" placeholder="7" />
      </label>
      <label class="eval-field">
        <span>Comentario</span>
        <textarea id="evalComment" rows="3" placeholder="Escribe tu comentario...">${escapeHtml(myComment)}</textarea>
      </label>
      <div class="eval-actions">
        <button id="evalSave" type="button">Guardar</button>
        <button id="evalSend" type="button" class="ghost">Enviar</button>
        ${isAuthenticated() ? '' : '<span class="eval-note">Modo invitado: solo evaluación</span>'}
      </div>
      <p id="evalMsg" class="eval-msg" aria-live="polite"></p>
    </div>
  </section>`;
}

async function openGitHubIssue(title, body, labels = []) {
  const token = await getGitHubIssueToken();
  const response = await fetch('https://api.github.com/repos/lerna-admin/media-evaluation-platform-static/issues', {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28'
    },
    body: JSON.stringify({
      title,
      body,
      labels: Array.isArray(labels) ? labels : [labels].filter(Boolean)
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GitHub issue create failed (${response.status} ${response.statusText})${text ? `: ${text}` : ''}`);
  }

  return response.json();
}

async function githubApiJson(pathname, init = {}) {
  const token = await getGitHubIssueToken();
  const response = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GitHub API failed (${response.status} ${response.statusText})${text ? `: ${text}` : ''}`);
  }
  return response.status === 204 ? null : response.json();
}

async function triggerWatchProgressQueueDrainIfNeeded() {
  if (!isAuthenticated()) return;
  const user = getAuthUser();
  if (!user?.email) return;

  const now = Date.now();
  const lockUntil = Number(localStorage.getItem(WATCH_PROGRESS_HEARTBEAT_LOCK_KEY) || '0');
  if (lockUntil && lockUntil > now) return;
  localStorage.setItem(WATCH_PROGRESS_HEARTBEAT_LOCK_KEY, String(now + 20 * 1000));

  try {
    const openIssues = await githubApiJson('/repos/lerna-admin/media-evaluation-platform-static/issues?state=open&labels=watch-progress-sync&per_page=1');
    const openCount = Array.isArray(openIssues) ? openIssues.length : 0;
    if (openCount <= 0) return;

    const resolveRuns = await githubApiJson('/repos/lerna-admin/media-evaluation-platform-static/actions/workflows/resolve-watch-progress-issue.yml/runs?per_page=10');
    const drainRuns = await githubApiJson('/repos/lerna-admin/media-evaluation-platform-static/actions/workflows/drain-watch-progress-queue.yml/runs?per_page=10');
    const hasActiveRun = [...(resolveRuns?.workflow_runs || []), ...(drainRuns?.workflow_runs || [])]
      .some((run) => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(String(run?.status || '').toLowerCase()));
    if (hasActiveRun) return;

    const lastDispatchAt = Number(localStorage.getItem(WATCH_PROGRESS_HEARTBEAT_DISPATCH_KEY) || '0');
    if (lastDispatchAt && (now - lastDispatchAt) < WATCH_PROGRESS_HEARTBEAT_DISPATCH_WINDOW_MS) return;

    await githubApiJson('/repos/lerna-admin/media-evaluation-platform-static/actions/workflows/drain-watch-progress-queue.yml/dispatches', {
      method: 'POST',
      body: JSON.stringify({ ref: 'main' })
    });
    localStorage.setItem(WATCH_PROGRESS_HEARTBEAT_DISPATCH_KEY, String(now));
  } catch {
    // Keep UI responsive; heartbeat is best effort.
  } finally {
    localStorage.removeItem(WATCH_PROGRESS_HEARTBEAT_LOCK_KEY);
  }
}

function startWatchProgressQueueHeartbeat() {
  if (watchProgressHeartbeatStarted) return;
  if (!isAuthenticated()) return;
  watchProgressHeartbeatStarted = true;
  triggerWatchProgressQueueDrainIfNeeded().catch(() => {});
  window.setInterval(() => {
    triggerWatchProgressQueueDrainIfNeeded().catch(() => {});
  }, WATCH_PROGRESS_HEARTBEAT_MS);
}

function showIssueFeedback({ kind, title, html, text, confirmText = 'OK' }) {
  const swal = window.Swal;
  if (swal?.fire) {
    return swal.fire({
      icon: kind,
      title,
      html,
      text,
      confirmButtonText: confirmText
    });
  }
  window.alert([title, text].filter(Boolean).join('\n\n'));
  return Promise.resolve();
}

async function notifyIssueCreated({ reloadMs = 60000 } = {}) {
  const swal = window.Swal;
  const waitSeconds = Math.max(0, Math.ceil(Number(reloadMs || 0) / 1000));
  const hardReload = () => {
    clearEpisodeLookupCaches();
    const url = new URL(window.location.href);
    url.searchParams.set('mep_reload', String(Date.now()));
    window.location.replace(url.toString());
  };
  if (swal?.fire) {
    let timerId = null;
    let endAt = Date.now() + reloadMs;
    const result = await swal.fire({
      icon: 'success',
      title: 'Solucionando',
      html: `
        <p class="swal-sync-countdown">Espera <strong id="episodeSyncCountdown">${waitSeconds}</strong> segundos.</p>
      `,
      showConfirmButton: false,
      allowOutsideClick: false,
      allowEscapeKey: false,
      timer: reloadMs,
      timerProgressBar: true,
      didOpen: () => {
        const countdownEl = swal.getHtmlContainer()?.querySelector('#episodeSyncCountdown');
        timerId = window.setInterval(() => {
          const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
          if (countdownEl) countdownEl.textContent = String(remaining);
          if (remaining <= 0 && timerId) {
            window.clearInterval(timerId);
            timerId = null;
          }
        }, 250);
      },
      willClose: () => {
        if (timerId) window.clearInterval(timerId);
        timerId = null;
      }
    });
    if (result.dismiss === swal.DismissReason.timer) {
      hardReload();
    } else if (reloadMs > 0) {
      window.setTimeout(hardReload, Math.max(0, reloadMs));
    }
    return;
  }

  window.alert(`Solucionando.\n\nEspera ${waitSeconds} segundos.`);
  window.setTimeout(hardReload, Math.max(0, reloadMs));
}

async function notifyUserRegistrationCreated(email, reloadMs = 60000) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const swal = window.Swal;
  const waitSeconds = Math.max(0, Math.ceil(Number(reloadMs || 0) / 1000));
  const handoffToLogin = () => {
    authMode = 'login';
    syncAuthModeUi();
    if (elements.authEmailLogin) elements.authEmailLogin.value = normalizedEmail;
    if (elements.authPasswordLogin) elements.authPasswordLogin.value = '';
    if (elements.authNameRegister) elements.authNameRegister.value = '';
    if (elements.authEmailRegister) elements.authEmailRegister.value = normalizedEmail;
    if (elements.authPasswordRegister) elements.authPasswordRegister.value = '';
    if (elements.authPasswordConfirmRegister) elements.authPasswordConfirmRegister.value = '';
    if (elements.authErrorLogin) elements.authErrorLogin.textContent = 'Usuario creado. Inicia sesión para continuar.';
    showAuthGate();
    window.setTimeout(() => elements.authPasswordLogin?.focus(), 0);
  };

  if (swal?.fire) {
    let timerId = null;
    let endAt = Date.now() + reloadMs;
    const result = await swal.fire({
      icon: 'success',
      title: 'Creando usuario',
      html: `
        <p class="swal-sync-countdown">Espera <strong id="episodeSyncCountdown">${waitSeconds}</strong> segundos.</p>
        <p class="swal-sync-note">El registro no es inmediato. Tu usuario quedará listo cuando termine el proceso.</p>
      `,
      showConfirmButton: false,
      allowOutsideClick: false,
      allowEscapeKey: false,
      timer: reloadMs,
      timerProgressBar: true,
      didOpen: () => {
        const countdownEl = swal.getHtmlContainer()?.querySelector('#episodeSyncCountdown');
        timerId = window.setInterval(() => {
          const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
          if (countdownEl) countdownEl.textContent = String(remaining);
          if (remaining <= 0 && timerId) {
            window.clearInterval(timerId);
            timerId = null;
          }
        }, 250);
      },
      willClose: () => {
        if (timerId) window.clearInterval(timerId);
        timerId = null;
      }
    });
    if (result.dismiss === swal.DismissReason.timer || reloadMs > 0) {
      handoffToLogin();
    }
    return;
  }

  window.alert(`Creando usuario.\n\nEsto no es inmediato. Espera ${waitSeconds} segundos.`);
  window.setTimeout(handoffToLogin, Math.max(0, reloadMs));
}

async function notifyIssueCreationError(error) {
  await showIssueFeedback({
    kind: 'error',
    title: 'No se pudo crear el issue',
    text: String(error?.message || error || 'Error desconocido')
  });
}

async function getGitHubIssueToken() {
  const token = decodeIssueToken(GITHUB_ISSUE_TOKEN_CIPHER, GITHUB_ISSUE_TOKEN_SEED);
  if (!token) throw new Error('Missing GitHub issue token.');
  return token;
}

function decodeIssueToken(cipherText, seed) {
  const encoded = String(cipherText || '').trim();
  const key = String(seed || '').trim();
  if (!encoded || !key) return '';

  const bytes = atob(encoded);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const decoded = bytes.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    out += String.fromCharCode(decoded);
  }
  return out.trim();
}

function buildIssueBody(title, lines) {
  return [
    `Title: ${title.title || ''}`,
    `Type: ${title.type || ''}`,
    title.imdbId ? `IMDb: ${title.imdbId}` : '',
    title.tmdbId ? `TMDB: ${title.tmdbId}` : '',
    '',
    ...(Array.isArray(lines) ? lines : []),
    '',
    `Page: ${window.location.href}`
  ].filter(Boolean).join('\n');
}

function buildWatchProgressIssueBody(snapshot) {
  return [
    'WATCH_PROGRESS_SYNC_REQUEST',
    `Email: ${String(snapshot?.email || '').trim().toLowerCase()}`,
    `Name: ${String(snapshot?.name || '').trim()}`,
    `IMDb: ${String(snapshot?.imdbId || '').trim()}`,
    `TMDB: ${String(snapshot?.tmdbId || '').trim()}`,
    `Title: ${String(state.selected?.title || '').trim()}`,
    `Type: ${String(state.selected?.type || '').trim()}`,
    `Season: ${positiveInteger(snapshot?.season, 1)}`,
    `Episode: ${positiveInteger(snapshot?.episode, 1)}`,
    `Progress: ${Number(snapshot?.progress || 0)}`,
    `EventType: ${String(snapshot?.event_type || '').trim()}`,
    `StartedAt: ${String(snapshot?.started_at || '').trim()}`,
    `CompletedAt: ${String(snapshot?.completed_at || '').trim()}`,
    `PlayerStatus: ${String(snapshot?.player_status || '').trim()}`,
    `UpdatedAt: ${new Date().toISOString()}`
  ].join('\n');
}

function getWatchProgressIssueKey(snapshot) {
  const id = String(snapshot?.imdbId || snapshot?.tmdbId || '').trim();
  return `${id}:${positiveInteger(snapshot?.season, 1)}x${positiveInteger(snapshot?.episode, 1)}`;
}

async function queueWatchProgressSync(snapshot) {
  const user = getAuthUser();
  if (!user?.email) return;
  const titleId = String(snapshot?.imdbId || snapshot?.tmdbId || '').trim();
  if (!titleId) return;

  const eventType = String(snapshot?.event_type || '').trim().toLowerCase();
  if (!['started', 'completed'].includes(eventType)) return;
  const key = getWatchProgressIssueKey(snapshot);
  const dedupe = `${WATCH_PROGRESS_LAST_SYNC_PREFIX}${user.email}:${key}:${eventType}`;
  const lastAt = Number(localStorage.getItem(dedupe) || '0');
  const now = Date.now();
  const windowMs = eventType === 'started' ? (30 * 60 * 1000) : (5 * 60 * 1000);
  if (lastAt && (now - lastAt) < windowMs) return;
  localStorage.setItem(dedupe, String(now));

  try {
    await openGitHubIssue(
      `Watch progress: ${user.name || user.email} <${user.email}>`,
      buildWatchProgressIssueBody({
        ...snapshot,
        email: user.email,
        name: user.name
      }),
      [WATCH_PROGRESS_SYNC_LABEL]
    );
  } catch {
    // local fallback remains authoritative if sync is unavailable
  }
}

function buildCatalogSeedSyncIssueBody(title) {
  return [
    'CATALOG_SEED_SYNC_REQUEST',
    `Type: ${String(title?.type || '').trim()}`,
    `IMDb: ${String(title?.imdbId || '').trim()}`,
    `TMDB: ${String(title?.tmdbId || '').trim()}`,
    `Title: ${String(title?.title || '').trim()}`,
    `Year: ${Number(title?.year) || ''}`,
    `PosterUrl: ${String(title?.posterUrl || '').trim()}`,
    `Description: ${String(title?.description || '').trim()}`,
    `Page: ${window.location.href}`,
    `CreatedAt: ${new Date().toISOString()}`
  ].join('\n');
}

function getSeedSyncKey(title) {
  const type = String(title?.type || '').trim().toLowerCase();
  const imdb = String(title?.imdbId || '').trim();
  const tmdb = String(title?.tmdbId || '').trim();
  if (!type || (!imdb && !tmdb)) return '';
  return `${type}:${imdb || tmdb}`;
}

function existsInSeedCatalog(title) {
  const key = getSeedSyncKey(title);
  if (!key) return false;
  try {
    const keys = JSON.parse(localStorage.getItem(SEED_CATALOG_KEYS_STORAGE) || '[]');
    return Array.isArray(keys) ? keys.includes(key) : false;
  } catch {
    return false;
  }
}

function queueCatalogSeedSyncForTitle(title) {
  const dedupeKey = getSeedSyncKey(title);
  if (!dedupeKey) return;
  const onceKey = `${SEED_SYNC_DEDUPE_PREFIX}${dedupeKey}`;
  if (existsInSeedCatalog(title)) {
    localStorage.removeItem(onceKey);
    return;
  }
  const now = Date.now();
  const lastAt = Number(localStorage.getItem(onceKey) || '0');
  if (lastAt && (now - lastAt) < SEED_SYNC_WINDOW_MS) return;
  localStorage.setItem(onceKey, String(now));
  void openGitHubIssue(
    `Catalog seed sync: ${String(title?.title || dedupeKey)}`,
    buildCatalogSeedSyncIssueBody(title),
    [SEED_SYNC_LABEL]
  ).catch(() => {
    localStorage.removeItem(onceKey);
  });
}

function bindEvaluationPanel(title) {
  const id = getTitleId(title);
  const msg = document.querySelector('#evalMsg');
  const voteEl = document.querySelector('#evalVote');
  const commentEl = document.querySelector('#evalComment');
  const saveBtn = document.querySelector('#evalSave');
  const sendBtn = document.querySelector('#evalSend');
  if (!voteEl || !commentEl || !saveBtn || !sendBtn) return;

  const save = () => {
    const voteRaw = String(voteEl.value || '').trim();
    const voteNum = voteRaw ? Number(voteRaw) : null;
    const vote = Number.isFinite(voteNum) ? Math.min(10, Math.max(1, Math.round(voteNum))) : null;
    const comment = String(commentEl.value || '').trim();
    const evals = loadEvaluations();
    evals[id] = { vote, comment, updatedAt: new Date().toISOString() };
    saveEvaluations(evals);
    if (msg) msg.textContent = 'Guardado.';
  };

  saveBtn.addEventListener('click', () => save());
  sendBtn.addEventListener('click', () => {
    save();
    const evals = loadEvaluations();
    const payload = evals[id] || {};
    const subject = encodeURIComponent(`Evaluación: ${title.title || id}`);
    const body = encodeURIComponent([
      `Título: ${title.title || ''}`,
      `Tipo: ${title.type || ''}`,
      title.imdbId ? `IMDb: ${title.imdbId}` : '',
      title.tmdbId ? `TMDB: ${title.tmdbId}` : '',
      '',
      `Voto: ${payload.vote ?? ''}`,
      `Comentario: ${payload.comment ?? ''}`,
      `Actualizado: ${payload.updatedAt ?? ''}`,
      '',
      `Página: ${window.location.href}`
    ].filter(Boolean).join('\n'));
    window.location.href = `mailto:${AUTH_EMAIL}?subject=${subject}&body=${body}`;
  });
}

function bindTap(element, handler) {
  if (!element) return;
  let pointerHandledAt = 0;
  const onTap = (event) => {
    event.preventDefault?.();
    handler(event);
  };
  element.addEventListener('pointerup', (event) => {
    pointerHandledAt = Date.now();
    onTap(event);
  }, { passive: false });
  element.addEventListener('click', (event) => {
    if (Date.now() - pointerHandledAt < 600) return;
    onTap(event);
  });
}

function renderCatalog() {
  if (isAdminUser()) {
    const titleEl = document.querySelector('.catalog-header h2');
    if (titleEl) titleEl.textContent = 'Dashboard';
    if (elements.sortFilter) elements.sortFilter.hidden = true;
    renderAdminDashboard();
    return;
  }
  const titleEl = document.querySelector('.catalog-header h2');
  if (titleEl) titleEl.textContent = 'Results';
  if (elements.sortFilter) elements.sortFilter.hidden = false;
  const query = elements.search.value.trim();
  populateGenreFilter();
  const baseFiltered = getFilteredLocalTitles();
  const filtered = sortTitles(baseFiltered);
  const shouldShowHome = query.length === 0 && !state.selected;

  if (shouldShowHome) {
    if (state.homeSectionView) {
      renderHomeSectionList(baseFiltered, state.homeSectionView);
      return;
    }
    renderHomeCatalog(baseFiltered);
    return;
  }

  setCatalogCount(`${filtered.length} items`);
  elements.items.innerHTML = renderLocalCards(filtered);
  bindLocalCardEvents();

  if (filtered.length === 0 && query.length >= 3 && state.isSearching) {
    elements.items.innerHTML = `<div class="loader-card"><span class="spinner"></span><strong>Searching IMDb/TMDB</strong><p>Looking for playable titles...</p></div>`;
  }
}

function renderAdminDashboard() {
  setCatalogCount('Panel administrador');
  elements.items.innerHTML = `<section class="admin-dashboard"><div class="loader-card"><span class="spinner"></span><strong>Cargando dashboard</strong><p>Recolectando métricas del sistema...</p></div></section>`;
  const user = getAuthUser();
  const userEmail = String(user?.email || '').trim().toLowerCase();

  Promise.all([
    fetchJsonWithTimeout('./assets/watch-progress/index.json', 3500).catch(() => ({ users: [] })),
    fetchJsonWithTimeout('./assets/users/index.json', 3500).catch(() => ({ users: [] })),
    fetchJsonWithTimeout('./assets/catalog.seed.json', 3500).catch(() => ({})),
    fetchJsonWithTimeout('./assets/roles/permissions.json', 3500).catch(() => ({ permissions: {} })),
    fetchJsonWithTimeout('./assets/roles/requests.json', 3500).catch(() => ({ requests: [] })),
    fetchJsonWithTimeout('./assets/roles/audit.json', 3500).catch(() => ({ events: [] })),
    fetchJsonWithTimeout('./assets/watch-analytics/events.json', 3500).catch(() => ({ events: [] })),
    fetchJsonWithTimeout('./assets/watch-analytics/by-content.json', 3500).catch(() => ({ items: [] })),
    fetchJsonWithTimeout('./assets/watch-analytics/by-user.json', 3500).catch(() => ({ users: [] })),
    fetchJsonWithTimeout('./assets/watch-analytics/summary.json', 3500).catch(() => ({})),
    fetchJsonWithTimeout('./assets/watch-analytics/xapi/index.json', 3500).catch(() => ({ users: [] }))
  ]).then(async ([watchIndex, usersIndex, seed, permissions, roleRequests, roleAudit, analyticsEvents, analyticsByContent, analyticsByUser, analyticsSummary, analyticsXapi]) => {
    const toTs = (value) => {
      const text = String(value || '').trim();
      if (!text) return 0;
      return Date.parse(text) || 0;
    };
    const users = Array.isArray(watchIndex?.users) ? watchIndex.users : [];
    const details = await Promise.all(users.slice(0, 100).map(async (entry) => {
      const rel = String(entry?.file || '').trim();
      if (!rel) return null;
      const file = rel.startsWith('users/') ? rel : `users/${rel}`;
      return fetchJsonWithTimeout(`./assets/watch-progress/${file}?v=${window.__mep_build || Date.now()}`, 3000).catch(() => null);
    }));
    const cleanDetails = details.filter(Boolean);
    const allUsersIndex = Array.isArray(usersIndex?.users) ? usersIndex.users : [];
    const userRoleRecords = await Promise.all(allUsersIndex.slice(0, 400).map(async (entry) => {
      const file = String(entry?.file || '').trim();
      if (!file) return null;
      return fetchJsonWithTimeout(`./assets/users/${encodeURIComponent(file)}?v=${window.__mep_build || Date.now()}`, 2500).catch(() => null);
    }));
    const roleUsers = userRoleRecords.filter(Boolean);
    const requests = Array.isArray(roleRequests?.requests) ? roleRequests.requests : [];
    const auditEvents = Array.isArray(roleAudit?.events) ? roleAudit.events : [];
    const permissionsCount = Object.keys(permissions?.permissions || {}).length;
    const analyticsEventRows = Array.isArray(analyticsEvents?.events) ? analyticsEvents.events : [];
    const analyticsContentRows = Array.isArray(analyticsByContent?.items) ? analyticsByContent.items : [];
    const analyticsUserRows = Array.isArray(analyticsByUser?.users) ? analyticsByUser.users : [];
    const analyticsXapiRows = Array.isArray(analyticsXapi?.users) ? analyticsXapi.users : [];
    const analyticsEnabled = analyticsEventRows.length > 0 || analyticsContentRows.length > 0 || analyticsUserRows.length > 0;
    const historyRows = analyticsEnabled
      ? analyticsEventRows
      : cleanDetails.flatMap((row) => Array.isArray(row?.history) ? row.history.map((entry) => ({
        ...entry,
        userEmail: String(entry?.userEmail || row?.email || '').trim().toLowerCase(),
        userName: String(entry?.userName || row?.name || '').trim()
      })) : []);

    const exportCsv = (rows, days) => {
      const header = ['updatedAt', 'userEmail', 'title', 'imdbId', 'tmdbId', 'season', 'episode', 'progress', 'playerStatus'];
      const lines = [header.join(',')];
      for (const row of rows) {
        const cols = [
          row.updatedAt || '',
          row.userEmail || '',
          row.title || '',
          row.imdbId || '',
          row.tmdbId || '',
          row.season || '',
          row.episode || '',
          row.progress || 0,
          row.playerStatus || ''
        ].map((v) => `"${String(v).replaceAll('"', '""')}"`);
        lines.push(cols.join(','));
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `admin-activity-${days}d-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    };

    const renderForWindow = (days) => {
      const now = Date.now();
      const windowStart = now - (days * 24 * 60 * 60 * 1000);
      const ago = (value) => {
        const ts = toTs(value);
        if (!ts) return 'n/a';
        const deltaMin = Math.max(1, Math.floor((now - ts) / 60000));
        if (deltaMin < 60) return `${deltaMin}m`;
        const hours = Math.floor(deltaMin / 60);
        if (hours < 48) return `${hours}h`;
        return `${Math.floor(hours / 24)}d`;
      };

      const scopedHistory = historyRows
        .map((row) => ({ ...row, userEmail: String(row?.userEmail || '').trim() }))
        .filter((row) => toTs(row?.updatedAt) >= windowStart);

      const activeUserEmails = analyticsEnabled
        ? new Set(scopedHistory.map((row) => String(row?.userEmail || '').trim().toLowerCase()).filter(Boolean))
        : new Set(cleanDetails
          .filter((u) => Array.isArray(u?.history) && u.history.some((h) => toTs(h?.updatedAt) >= windowStart))
          .map((u) => String(u?.email || '').trim().toLowerCase())
        );

      const totalUsers = allUsersIndex.length || Number(analyticsSummary?.totalUsers || 0) || users.length;
      const activeUsers = activeUserEmails.size;
      const totalHistory = scopedHistory.length;
      const avgHistoryPerActive = activeUsers ? Math.round(totalHistory / activeUsers) : 0;
      const usersWithAnyActivity = analyticsEnabled
        ? new Set(analyticsUserRows
          .filter((row) => Number(row?.totalEvents || 0) > 0)
          .map((row) => String(row?.userEmail || '').trim().toLowerCase())
          .filter(Boolean))
        : new Set(cleanDetails
          .filter((row) => {
            const hasHistory = Array.isArray(row?.history) && row.history.length > 0;
            const hasProgress = row?.progress && Object.keys(row.progress).length > 0;
            return hasHistory || hasProgress;
          })
          .map((row) => String(row?.email || '').trim().toLowerCase())
          .filter(Boolean));
      const inactiveUsers = roleUsers
        .filter((row) => !usersWithAnyActivity.has(String(row?.email || '').trim().toLowerCase()))
        .sort((a, b) => String(a?.name || a?.email || '').localeCompare(String(b?.name || b?.email || ''), 'es', { sensitivity: 'base' }));

      const progressRows = analyticsEnabled ? [] : cleanDetails.flatMap((row) => Object.values(row?.progress || {}));
      const completionRate = analyticsEnabled
        ? Math.round(Number(analyticsSummary?.overallCompletionRate || 0) * 100)
        : progressRows.length
          ? Math.round((progressRows.filter((p) => Number(p?.lastProgress || p?.progress || 0) >= 95).length / progressRows.length) * 100)
          : 0;

      const requestsWithAge = requests.map((row) => ({ ...row, ts: toTs(row?.requestedAt) }));
      const pendingRequests = requestsWithAge.filter((row) => String(row?.status || '').toLowerCase() === 'pending');
      const approvedRequests = requestsWithAge.filter((row) => String(row?.status || '').toLowerCase() === 'approved');
      const oldestPending = pendingRequests.sort((a, b) => a.ts - b.ts)[0] || null;
      const oldestPendingHours = oldestPending ? Math.floor((now - (oldestPending.ts || now)) / (60 * 60 * 1000)) : 0;
      const slaClass = oldestPendingHours >= 48 ? 'sla-critical' : oldestPendingHours >= 24 ? 'sla-warning' : 'sla-ok';
      const slaLabel = oldestPending ? `${oldestPendingHours}h` : '0h';

      const viewers = roleUsers.filter((row) => String(row?.role || 'viewer').toLowerCase() === 'viewer').length;
      const agents = roleUsers.filter((row) => String(row?.role || '').toLowerCase() === 'agent').length;
      const admins = roleUsers.filter((row) => String(row?.role || '').toLowerCase() === 'admin').length;
      const roleShareTotal = Math.max(1, totalUsers);
      const viewerPct = Math.round((viewers / roleShareTotal) * 100);
      const agentPct = Math.round((agents / roleShareTotal) * 100);
      const adminPct = Math.round((admins / roleShareTotal) * 100);

      const titleHits = new Map();
      if (analyticsEnabled) {
        for (const row of analyticsContentRows) {
          const id = String(row?.contentId || row?.imdbId || row?.tmdbId || '').trim();
          const name = String(row?.title || id).trim();
          if (!id || !name || /^\d{5,}$/.test(name)) continue;
          titleHits.set(id, {
            id,
            name,
            plays: Number(row?.totalStarts || row?.totalEvents || 0),
            completed: Number(row?.totalCompletions || 0)
          });
        }
      } else {
        for (const event of scopedHistory) {
          const id = String(event?.imdbId || event?.tmdbId || '').trim();
          if (!id) continue;
          const name = String(event?.title || id).trim();
          if (!name || /^\d{5,}$/.test(name)) continue;
          const prev = titleHits.get(id) || { id, name, plays: 0, completed: 0 };
          prev.plays += 1;
          if (String(event?.playerStatus || '').toLowerCase() === 'completed') prev.completed += 1;
          titleHits.set(id, prev);
        }
      }
      const topTitles = [...titleHits.values()].sort((a, b) => b.plays - a.plays).slice(0, 6);
      const maxTopPlays = topTitles.length ? Math.max(...topTitles.map((row) => row.plays)) : 1;

      const bucketDays = Math.min(days, 14);
      const dailyBuckets = new Map();
      for (let i = bucketDays - 1; i >= 0; i -= 1) {
        const d = new Date(now - (i * 24 * 60 * 60 * 1000));
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        dailyBuckets.set(key, 0);
      }
      for (const row of scopedHistory) {
        const ts = toTs(row?.updatedAt);
        if (!ts) continue;
        const d = new Date(ts);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        if (dailyBuckets.has(key)) dailyBuckets.set(key, (dailyBuckets.get(key) || 0) + 1);
      }
      const daily = [...dailyBuckets.entries()].map(([date, count]) => ({ date, count }));
      const maxDaily = daily.length ? Math.max(...daily.map((row) => row.count), 1) : 1;

      const movieCount = Array.isArray(seed?.movies) ? seed.movies.length : 0;
      const seriesCount = Array.isArray(seed?.series) ? seed.series.length : 0;
      const adminNote = userEmail === ADMIN_EMAIL ? 'Usuario administrador activo' : 'Rol administrador activo';

      elements.items.innerHTML = `
        <section class="admin-dashboard">
          <header class="admin-hero">
            <div>
              <h3>Centro de Control</h3>
              <p class="admin-note">${escapeHtml(adminNote)} · Ventana activa: ${days} días.</p>
            </div>
            <div class="admin-pill-row">
              <button class="admin-pill-btn ${days === 7 ? 'active' : ''}" data-admin-window="7">7d</button>
              <button class="admin-pill-btn ${days === 30 ? 'active' : ''}" data-admin-window="30">30d</button>
              <button class="admin-pill-btn ${days === 90 ? 'active' : ''}" data-admin-window="90">90d</button>
              <button class="admin-pill-btn" id="adminExportCsv">Export CSV</button>
            </div>
          </header>

          <section class="admin-role-provision">
            <h4>Crear Agente</h4>
            <div class="admin-role-grid">
              <input id="adminAgentName" type="text" placeholder="Nombre del agente" />
              <input id="adminAgentEmail" type="email" placeholder="Correo del agente" />
              <input id="adminAgentPassword" type="password" placeholder="Password temporal" />
              <button id="adminCreateAgent" type="button">Crear agente</button>
              <button id="adminRunQueue" type="button" class="admin-ghost">Procesar cola</button>
              <button id="adminRunDeploy" type="button" class="admin-ghost">Publicar sitio</button>
            </div>
            <p id="adminRoleMsg" class="admin-role-msg" aria-live="polite"></p>
          </section>

          <div class="admin-kpis">
            <article class="admin-kpi"><strong>${totalUsers}</strong><span>Usuarios registrados</span></article>
            <article class="admin-kpi"><strong>${activeUsers}</strong><span>Usuarios activos (${days}d)</span></article>
            <article class="admin-kpi"><strong>${totalHistory}</strong><span>Eventos (${days}d)</span></article>
            <article class="admin-kpi"><strong>${avgHistoryPerActive}</strong><span>Prom. eventos/activo</span></article>
            <article class="admin-kpi"><strong>${inactiveUsers.length}</strong><span>Usuarios sin actividad</span></article>
            <article class="admin-kpi"><strong>${analyticsXapiRows.filter((row) => Number(row?.statementCount || 0) > 0).length}</strong><span>Usuarios con xAPI</span></article>
            <article class="admin-kpi"><strong>${completionRate}%</strong><span>Finalización global</span></article>
            <article class="admin-kpi"><strong>${movieCount}</strong><span>Películas seed</span></article>
            <article class="admin-kpi"><strong>${seriesCount}</strong><span>Series seed</span></article>
            <article class="admin-kpi"><strong>${permissionsCount}</strong><span>Roles con permisos</span></article>
            <article class="admin-kpi"><strong>${pendingRequests.length}</strong><span>Pendientes</span></article>
            <article class="admin-kpi"><strong>${approvedRequests.length}</strong><span>Aprobadas</span></article>
            <article class="admin-kpi ${slaClass}"><strong>${slaLabel}</strong><span>SLA pendiente más viejo</span></article>
          </div>

          <div class="admin-grid-panels">
            <section class="admin-panel">
              <h4>Actividad últimos ${bucketDays} días</h4>
              <div class="admin-spark">${daily.map((row) => `<div class="admin-spark-col"><i style="height:${Math.max(6, Math.round((row.count / maxDaily) * 100))}%"></i><span>${escapeHtml(row.date.slice(5))}</span></div>`).join('')}</div>
            </section>

            <section class="admin-panel">
              <h4>Distribución por roles</h4>
              <div class="admin-donut" style="--viewer:${viewerPct};--agent:${agentPct};--admin:${adminPct};"></div>
              <div class="admin-legend">
                <span><i class="sw-viewer"></i>Viewer ${viewerPct}%</span>
                <span><i class="sw-agent"></i>Agent ${agentPct}%</span>
                <span><i class="sw-admin"></i>Admin ${adminPct}%</span>
              </div>
            </section>

            <section class="admin-panel">
              <h4>Top títulos por consumo</h4>
              <div class="admin-chart">${topTitles.map((row) => `<div class="admin-bar"><span class="admin-bar-label">${escapeHtml(row.name)}</span><div class="admin-bar-track"><i style="width:${Math.max(8, Math.round((row.plays / maxTopPlays) * 100))}%"></i></div><small>${row.plays} plays · ${row.completed} completados</small></div>`).join('') || '<p>Sin datos.</p>'}</div>
            </section>

            <section class="admin-panel">
              <h4>Provisionamiento reciente</h4>
              <div class="admin-chart">${requests.slice(0, 8).map((row) => `<div class="admin-bar"><span class="admin-bar-label">${escapeHtml(`${row.role || 'role'} · ${row.email || 'n/a'}`)}</span><small>${escapeHtml(`${row.status || 'unknown'} · hace ${ago(row.requestedAt)}`)}</small></div>`).join('') || '<p>Sin solicitudes.</p>'}</div>
            </section>

            <section class="admin-panel">
              <h4>Usuarios sin actividad</h4>
              <div class="admin-chart">${inactiveUsers.slice(0, 10).map((row) => `<div class="admin-bar"><span class="admin-bar-label">${escapeHtml(String(row?.name || row?.email || 'Usuario'))}</span><small>${escapeHtml(`${String(row?.email || 'n/a')} · ${String(row?.role || 'viewer').toLowerCase()} · sin reproducciones`)}</small></div>`).join('') || '<p>Todos los usuarios tienen actividad.</p>'}</div>
            </section>

            <section class="admin-panel">
              <h4>xAPI por usuario</h4>
              <div class="admin-chart">${analyticsXapiRows.slice(0, 10).map((row) => {
                const count = Number(row?.statementCount || 0);
                const activityLabel = count > 0 ? `última ${ago(row?.lastStatementAt)}` : 'sin actividad';
                return `<div class="admin-bar"><span class="admin-bar-label">${escapeHtml(String(row?.userName || row?.userEmail || 'Usuario'))}</span><small>${escapeHtml(`${String(row?.userEmail || 'n/a')} · ${count} statements · ${activityLabel}`)}</small></div>`;
              }).join('') || '<p>Sin statements xAPI.</p>'}</div>
            </section>

            <section class="admin-panel">
              <h4>Auditoría de roles</h4>
              <div class="admin-chart">${auditEvents.slice(0, 8).map((row) => `<div class="admin-bar"><span class="admin-bar-label">${escapeHtml(`${row.type || 'event'} · ${row.email || 'n/a'}`)}</span><small>${escapeHtml(String(row.processedAt || row.requestedAt || '').replace('T', ' ').slice(0, 16))}</small></div>`).join('') || '<p>Sin eventos.</p>'}</div>
            </section>
          </div>
        </section>`;

      document.querySelectorAll('[data-admin-window]').forEach((btn) => {
        btn.addEventListener('click', () => renderForWindow(Number(btn.dataset.adminWindow || '7')));
      });

      document.querySelector('#adminExportCsv')?.addEventListener('click', () => exportCsv(scopedHistory, days));

      const createBtn = document.querySelector('#adminCreateAgent');
      createBtn?.addEventListener('click', async () => {
        const msg = document.querySelector('#adminRoleMsg');
        const name = String(document.querySelector('#adminAgentName')?.value || '').trim();
        const email = String(document.querySelector('#adminAgentEmail')?.value || '').trim().toLowerCase();
        const password = String(document.querySelector('#adminAgentPassword')?.value || '');
        if (msg) msg.textContent = 'Creando issue para provisionar agente...';
        const result = await createAgentByAdmin({ name, email, password }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
        if (!result.ok) {
          if (msg) msg.textContent = result.error || 'No se pudo crear el agente.';
          return;
        }
        if (msg) msg.textContent = 'Issue creado. El pipeline creará el usuario agente en JSON.';
      });

      document.querySelector('#adminRunQueue')?.addEventListener('click', async () => {
        const msg = document.querySelector('#adminRoleMsg');
        if (msg) msg.textContent = 'Disparando workflow de cola...';
        try {
          await githubApiJson('/repos/lerna-admin/media-evaluation-platform-static/actions/workflows/drain-watch-progress-queue.yml/dispatches', {
            method: 'POST',
            body: JSON.stringify({ ref: 'main' })
          });
          if (msg) msg.textContent = 'Workflow de cola enviado correctamente.';
        } catch (error) {
          if (msg) msg.textContent = `No se pudo disparar cola: ${String(error?.message || error)}`;
        }
      });

      document.querySelector('#adminRunDeploy')?.addEventListener('click', async () => {
        const msg = document.querySelector('#adminRoleMsg');
        if (msg) msg.textContent = 'Disparando workflow de deploy...';
        try {
          await githubApiJson('/repos/lerna-admin/media-evaluation-platform-static/actions/workflows/deploy-pages.yml/dispatches', {
            method: 'POST',
            body: JSON.stringify({ ref: 'main' })
          });
          if (msg) msg.textContent = 'Deploy solicitado correctamente.';
        } catch (error) {
          if (msg) msg.textContent = `No se pudo disparar deploy: ${String(error?.message || error)}`;
        }
      });
    };

    renderForWindow(7);
  }).catch(() => {
    elements.items.innerHTML = `<section class="admin-dashboard"><div class="empty">No se pudieron cargar métricas del sistema.</div></section>`;
  });
}

window.mepAdminCreateAgent = createAgentByAdmin;

function renderHomeCatalog(baseFiltered) {
  cleanupWatchLaterFromCompleted(baseFiltered);
  const prefs = loadTitlePrefs();
  const watch = buildWatchInsights();
  const continueItems = sortTitles(baseFiltered.filter((t) => watch.continueIds.has(getTitleId(t)))).sort((a, b) => (watch.recentAt[getTitleId(b)] || 0) - (watch.recentAt[getTitleId(a)] || 0));
  const rewatchItems = sortTitles(baseFiltered.filter((t) => watch.completedIds.has(getTitleId(t)))).sort((a, b) => (watch.scores[getTitleId(b)] || 0) - (watch.scores[getTitleId(a)] || 0));
  const watchLaterItems = sortTitles(baseFiltered.filter((t) => Boolean(prefs.watchLater?.[getTitleId(t)])));
  const movieRecommended = sortTitles(baseFiltered.filter((t) => t.type === 'movie')).sort((a, b) => recommendationScore(b, watch) - recommendationScore(a, watch));
  const seriesRecommended = sortTitles(baseFiltered.filter((t) => t.type === 'series')).sort((a, b) => recommendationScore(b, watch) - recommendationScore(a, watch));

  const section = (key, title, subtitle, items) => {
    const preview = items.slice(0, 10);
    const showMore = items.length > preview.length;
    const cards = `${preview.length ? renderLocalCards(preview) : '<div class="empty">Sin resultados por ahora.</div>'}${showMore ? `<article class="home-more" data-home-seeall="${escapeAttribute(key)}"><div class="home-more-icon" aria-hidden="true">→</div><strong>Explorar todo</strong><span>Ver el listado completo</span></article>` : ''}`;
    return `
    <section class="home-section">
      <div class="home-section-head">
        <h3>${escapeHtml(title)}</h3>
        <span>${escapeHtml(subtitle)}</span>
      </div>
      <div class="home-carousel" data-home-carousel="${escapeAttribute(key)}">
        <button class="home-nav home-nav-prev" type="button" data-home-prev aria-label="Anterior">‹</button>
        <div class="home-viewport">
          <div class="home-track">
            ${cards}
          </div>
        </div>
        <button class="home-nav home-nav-next" type="button" data-home-next aria-label="Siguiente">›</button>
      </div>
    </section>
  `;
  };

  setCatalogCount(`${baseFiltered.length} items`);
  const sections = [
    section('watch_later', 'Ver mas tarde', 'Titulos que guardaste para despues', watchLaterItems),
    section('continue', 'Continuar viendo', 'Peliculas incompletas y series en curso', continueItems),
    section('movies_recommended', 'Peliculas que podrian gustarte', 'Basado en tus generos y actores', movieRecommended),
    section('series_recommended', 'Series que podrian gustarte', 'Basado en tus generos y actores', seriesRecommended)
  ];
  for (const group of HOME_STREAMING_GROUPS) {
    const movies = sortTitles(baseFiltered.filter((t) => t.type === 'movie' && titleHasProvider(t, group.aliases || [group.key])));
    const series = sortTitles(baseFiltered.filter((t) => t.type === 'series' && titleHasProvider(t, group.aliases || [group.key])));
    if (movies.length === 0 && series.length === 0) continue;
    sections.push(section(`platform_${group.key}_movies`, `${group.label} Movies`, `Peliculas disponibles en ${group.label}`, movies));
    sections.push(section(`platform_${group.key}_series`, `${group.label} Series`, `Series disponibles en ${group.label}`, series));
  }
  sections.push(section('rewatch', 'Volver a ver', 'Titulos que ya completaste', rewatchItems));
  elements.items.innerHTML = sections.join('');
  bindLocalCardEvents();
  bindHomeSectionEvents();
  bindHomeCarouselEvents();
}

function renderHomeSectionList(baseFiltered, sectionKey) {
  cleanupWatchLaterFromCompleted(baseFiltered);
  const prefs = loadTitlePrefs();
  const watch = buildWatchInsights();
  let title = 'Listado';
  let items = [];
  if (sectionKey === 'watch_later') {
    title = 'Ver mas tarde';
    items = sortTitles(baseFiltered.filter((t) => Boolean(prefs.watchLater?.[getTitleId(t)])));
  } else if (sectionKey === 'continue') {
    title = 'Continuar viendo';
    items = sortTitles(baseFiltered.filter((t) => watch.continueIds.has(getTitleId(t)))).sort((a, b) => (watch.recentAt[getTitleId(b)] || 0) - (watch.recentAt[getTitleId(a)] || 0));
  } else if (sectionKey === 'rewatch') {
    title = 'Volver a ver';
    items = sortTitles(baseFiltered.filter((t) => watch.completedIds.has(getTitleId(t)))).sort((a, b) => (watch.scores[getTitleId(b)] || 0) - (watch.scores[getTitleId(a)] || 0));
  } else if (sectionKey === 'movies_recommended') {
    title = 'Peliculas que podrian gustarte';
    items = sortTitles(baseFiltered.filter((t) => t.type === 'movie')).sort((a, b) => recommendationScore(b, watch) - recommendationScore(a, watch));
  } else if (sectionKey === 'series_recommended') {
    title = 'Series que podrian gustarte';
    items = sortTitles(baseFiltered.filter((t) => t.type === 'series')).sort((a, b) => recommendationScore(b, watch) - recommendationScore(a, watch));
  } else if (sectionKey.startsWith('platform_')) {
    const match = sectionKey.match(/^platform_([a-z0-9]+)_(movies|series)$/);
    if (match) {
      const providerKey = match[1];
      const kind = match[2] === 'movies' ? 'movie' : 'series';
      const group = HOME_STREAMING_GROUPS.find((entry) => entry.key === providerKey);
      const providerLabel = group?.label || providerKey;
      title = `${providerLabel} ${kind === 'movie' ? 'Movies' : 'Series'}`;
      items = sortTitles(baseFiltered.filter((t) => t.type === kind && titleHasProvider(t, group?.aliases || [providerKey])));
    }
  }
  setCatalogCount(`${items.length} items`);
  elements.items.innerHTML = `
    <section class="home-section-list">
      <div class="home-section-list-head">
        <h3>${escapeHtml(title)}</h3>
        <button type="button" id="homeBack">Volver al Home</button>
      </div>
      <div class="items">${items.length ? renderLocalCards(items) : '<div class="empty">Sin resultados por ahora.</div>'}</div>
    </section>`;
  bindLocalCardEvents();
  document.querySelector('#homeBack')?.addEventListener('click', () => {
    state.homeSectionView = null;
    renderCatalog();
  });
}

function bindHomeSectionEvents() {
  elements.items.querySelectorAll('[data-home-seeall]').forEach((entry) => {
    entry.addEventListener('click', () => {
      state.homeSectionView = entry.dataset.homeSeeall || null;
      renderCatalog();
    });
  });
}

function bindHomeCarouselEvents() {
  const carousels = elements.items.querySelectorAll('[data-home-carousel]');
  carousels.forEach((carousel) => {
    const viewport = carousel.querySelector('.home-viewport');
    const track = carousel.querySelector('.home-track');
    const prevBtn = carousel.querySelector('[data-home-prev]');
    const nextBtn = carousel.querySelector('[data-home-next]');
    if (!viewport || !track || !prevBtn || !nextBtn) return;

    const cards = [...track.children];
    let page = 0;
    let dragState = null;

    const metrics = () => {
      if (cards.length === 0) return { perPage: 1, maxPage: 0, step: 0 };
      const cardWidth = cards[0].getBoundingClientRect().width || 1;
      const secondLeft = cards[1]?.offsetLeft ?? cards[0].offsetLeft;
      const gap = Math.max(0, secondLeft - cards[0].offsetLeft - cardWidth);
      const perPage = Math.max(1, Math.floor((viewport.clientWidth + gap) / (cardWidth + gap)));
      const maxPage = Math.max(0, Math.ceil(cards.length / perPage) - 1);
      const step = perPage * (cardWidth + gap);
      return { perPage, maxPage, step };
    };

    const apply = () => {
      const { maxPage, step } = metrics();
      page = Math.min(Math.max(0, page), maxPage);
      const translateX = dragState?.currentTranslate ?? (-page * step);
      track.style.transform = `translateX(${translateX}px)`;
      prevBtn.disabled = page <= 0;
      nextBtn.disabled = page >= maxPage;
    };

    const finishDrag = () => {
      if (!dragState) return;
      const wasDragged = dragState.moved;
      const { step, maxPage } = metrics();
      if (step > 0 && wasDragged) {
        const snappedPage = Math.round(-dragState.currentTranslate / step);
        page = Math.min(Math.max(0, snappedPage), maxPage);
      }
      dragState = null;
      carousel.classList.remove('is-dragging');
      apply();
      if (wasDragged) {
        homeCarouselLastDragAt.set(carousel, Date.now());
      }
    };

    const updateDrag = (clientX, clientY) => {
      if (!dragState) return;
      const deltaX = clientX - dragState.startX;
      const deltaY = clientY - dragState.startY;
      if (!dragState.moved) {
        if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 8) {
          dragState = null;
          carousel.classList.remove('is-dragging');
          apply();
          return;
        }
        if (Math.abs(deltaX) < 6) return;
        dragState.moved = true;
      }
      const { step, maxPage } = metrics();
      const minTranslate = -maxPage * step;
      const maxTranslate = 0;
      const rawTranslate = dragState.startTranslate + deltaX;
      dragState.currentTranslate = Math.min(maxTranslate, Math.max(minTranslate, rawTranslate));
      track.style.transform = `translateX(${dragState.currentTranslate}px)`;
      if (dragState.moved && step > 0) {
        page = Math.min(Math.max(0, Math.round(-dragState.currentTranslate / step)), maxPage);
      }
      prevBtn.disabled = page <= 0;
      nextBtn.disabled = page >= maxPage;
    };

    prevBtn.addEventListener('click', () => {
      page -= 1;
      apply();
    });
    nextBtn.addEventListener('click', () => {
      page += 1;
      apply();
    });

    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      const { step } = metrics();
      if (step <= 0) return;
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTranslate: -page * step,
        currentTranslate: -page * step,
        moved: false,
        captured: false
      };
    });

    viewport.addEventListener('pointermove', (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      const beforeMoved = dragState.moved;
      updateDrag(event.clientX, event.clientY);
      if (!beforeMoved && dragState.moved) {
        carousel.classList.add('is-dragging');
        if (!dragState.captured) {
          try {
            viewport.setPointerCapture(event.pointerId);
            dragState.captured = true;
          } catch {}
        }
      }
      if (dragState.moved && event.cancelable) event.preventDefault();
    }, { passive: false });

    const endDrag = (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      if (dragState.captured) {
        try {
          viewport.releasePointerCapture(event.pointerId);
        } catch {}
      }
      finishDrag();
    };

    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', apply);
    apply();
  });
}

function getFilteredLocalTitles() {
  const query = elements.search.value.trim().toLowerCase();
  const type = elements.typeFilter.value;
  const selectedGenre = (elements.genreFilter?.value || 'all').toLowerCase();
  const titles = loadLocalCatalog();
  return titles.filter((title) => {
    if (title.type === 'episode') return false;
    const genres = (title.metadata?.genres || title.categories || []).map((g) => String(g).toLowerCase());
    const haystack = [title.title, title.showTitle, title.imdbId, title.tmdbId, ...genres].join(' ').toLowerCase();
    const genreMatches = selectedGenre === 'all' || genres.some((g) => g === selectedGenre);
    return (type === 'all' || title.type === type) && genreMatches && (!query || haystack.includes(query));
  });
}

function populateGenreFilter() {
  const select = elements.genreFilter;
  if (!select) return;
  const current = select.value || 'all';
  const genres = new Set();
  for (const title of loadLocalCatalog()) {
    const list = title.metadata?.genres || title.categories || [];
    for (const genre of list) {
      const value = String(genre || '').trim();
      if (value) genres.add(value);
    }
  }
  const sorted = [...genres].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
  select.innerHTML = `<option value="all">Todos los generos</option>${sorted.map((g) => `<option value="${escapeAttribute(g.toLowerCase())}">${escapeHtml(g)}</option>`).join('')}`;
  const next = [...select.options].some((opt) => opt.value === current) ? current : 'all';
  select.value = next;
}

function renderLocalCards(titles) {
  const isAdmin = isAdminUser();
  const prefs = loadTitlePrefs();
  return titles.map((title) => {
    const active = state.selected?.catalogKey === title.catalogKey ? ' active' : '';
    const poster = title.posterUrl || title.metadata?.posterUrl || '';
    const unavailable = isAuthenticated() && title.playable === false ? '<span class="pill pill-warn">No disponible</span>' : '';
    const typeLabel = title.type === 'series' ? 'Serie' : title.type === 'movie' ? 'Película' : String(title.type || '');
    const startYear = title.year ?? '';
    const endYear = title.type === 'series' ? (title.metadata?.endYear ?? '') : '';
    const yearLabel = endYear && startYear ? `${startYear}-${endYear}` : (startYear || '');
    const canPlay = !isAdmin && isAuthenticated() && title.playable !== false && (title.type === 'movie' || title.type === 'series');
    const playOverlay = canPlay ? `<button class="item-play" type="button" aria-label="Play" data-play-key="${escapeHtml(title.catalogKey)}"><span class="item-play-icon" aria-hidden="true">▶</span></button>` : '';
    return `<article class="item${active}" data-key="${escapeHtml(title.catalogKey)}">
      ${poster ? `<img class="item-poster" src="${escapeAttribute(poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="item-poster placeholder"></div>'}
      ${playOverlay}
      <div><strong>${escapeHtml(title.title)}</strong>${getCardQuickActions(title, prefs)}${unavailable}<span class="meta">${escapeHtml([typeLabel, yearLabel].filter(Boolean).join(' | '))}</span></div>
    </article>`;
  }).join('');
}

function bindLocalCardEvents() {
  elements.items.querySelectorAll('.item-quick-btn').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = String(btn.dataset.quickAction || '').trim();
      const prefId = String(btn.dataset.prefId || '').trim();
      const card = btn.closest('.item');
      const key = String(card?.dataset?.key || '').trim();
      if (!action || (!prefId && !key)) return;
      let title = null;
      if (key) title = loadLocalCatalog().find((entry) => entry.catalogKey === key) || null;
      if (!title && prefId) title = loadLocalCatalog().find((entry) => String(getTitleId(entry) || '').trim() === prefId) || null;
      if (!title && state.selected && String(getTitleId(state.selected) || '').trim() === prefId) title = state.selected;
      if (!title) return;
      setTitlePreference(title, action);
      const id = String(getTitleId(title) || '').trim();
      updateQuickActionButtons(id);
      if (action === 'later' && state.homeSectionView === 'watch_later' && card) {
        const prefs = loadTitlePrefs();
        if (!prefs.watchLater?.[id]) card.remove();
      }
    });
  });

  elements.items.querySelectorAll('.item-play').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const key = btn.dataset.playKey;
      if (!key) return;
      const selected = loadLocalCatalog().find((title) => title.catalogKey === key);
      if (!selected) return;
      state.selected = selected;
      state.seriesEpisodes = null;
      state.seriesEpisodesLoading = isAuthenticated() && isSeriesLike(state.selected);
      state.hydratedProgressId = '';

      if (isSeriesLike(state.selected)) {
        // Default to the first episode; if we have progress, existing routing/hydration will adjust.
        state.playback.season = 1;
        state.playback.episode = 1;
        await loadSeriesEpisodes().catch(() => {});
      }
      openPlayerForCurrentSelection();
    });
  });

  elements.items.querySelectorAll('.item').forEach((item) => {
    if (!item.dataset.key) return;
    item.addEventListener('click', async () => {
      if (isAdminUser()) return;
      const homeCarousel = item.closest('[data-home-carousel]');
      if (homeCarousel) {
        const lastDragAt = homeCarouselLastDragAt.get(homeCarousel) || 0;
        if (Date.now() - lastDragAt < 350) return;
      }
      state.selected = loadLocalCatalog().find((title) => title.catalogKey === item.dataset.key);
      if (isAuthenticated() && state.selected) queueCatalogSeedSyncForTitle(state.selected);
      state.seriesEpisodes = null;
      state.seriesEpisodesLoading = isAuthenticated() && isSeriesLike(state.selected);
      state.hydratedProgressId = '';
      renderCatalog();
      renderDetail();
      if (isAuthenticated() && isSeriesLike(state.selected)) loadSeriesEpisodes().then(renderDetail);
      syncRoute();
      hydrateSelectedFromTmdb().then(() => renderDetail({ skipHydratePlayback: true }));
    });
  });
}

function scheduleRemoteSearch() {
  clearTimeout(state.remoteSearchTimer);
  const intentId = state.searchIntentId;
  const query = elements.search.value.trim();
  state.searchingTerm = query;
  if (query.length < 3) {
    state.isSearching = false;
    renderCatalog();
    return;
  }
  if (!isAuthenticated()) return;
  const remoteKey = [
    query.toLowerCase(),
    elements.typeFilter.value || 'all'
  ].join('|');
  state.isSearching = true;
  renderCatalog();
  state.remoteSearchTimer = setTimeout(async () => {
    if (intentId !== state.searchIntentId) return;
    if (state.lastRemoteQuery === remoteKey) return;
    state.lastRemoteQuery = remoteKey;
    await searchRemoteCatalog(query, intentId);
    state.isSearching = false;
    syncRoute();
  }, 700);
}

function scheduleSearchCommit() {
  clearTimeout(state.searchCommitTimer);
  const intentId = state.searchIntentId;
  state.searchCommitTimer = setTimeout(async () => {
    if (intentId !== state.searchIntentId) return;
    const query = elements.search.value.trim();
    state.searchingTerm = query;
    state.lastRemoteQuery = '';
    syncRoute();
    if (!isAuthenticated()) {
      state.isSearching = false;
      renderCatalog();
      return;
    }
    if (query.length < 3) {
      state.isSearching = false;
      renderCatalog();
      return;
    }
    state.isSearching = true;
    setCatalogCount(state.lastCountLabel || '0 items');
    await searchRemoteCatalog(query, intentId);
  }, 1200);
}

async function searchRemoteCatalog(query, intentId = state.searchIntentId) {
  try {
    const results = await searchViaListingsAndImdb(query, elements.typeFilter.value);
    if (intentId !== state.searchIntentId) return;
    const withPlayable = results.map((item) => ({ ...item, playable: true }));
    state.remoteResults = sortByRelevance(dedupe(withPlayable), query).slice(0, 36).map(normalizeSelection);
    for (const remoteTitle of state.remoteResults) queueCatalogSeedSyncForTitle(remoteTitle);
    cacheSearchResults(state.remoteResults);
    if (intentId !== state.searchIntentId) return;
    renderRemoteResults(query);
  } catch (error) {
    if (intentId !== state.searchIntentId) return;
    elements.items.innerHTML = `<div class="empty error">Search failed: ${escapeHtml(error.message)}</div>`;
  } finally {
    if (intentId === state.searchIntentId) {
      state.isSearching = false;
      setCatalogCount(state.lastCountLabel || '0 items');
    }
  }
}

function renderRemoteResults(query) {
  cleanupWatchLaterFromCompleted();
  const prefs = loadTitlePrefs();
  const localResults = getFilteredLocalTitles();
  const merged = sortResultEntries(mergeAndRankResults(localResults, state.remoteResults, query));
  setCatalogCount(`${merged.length} matches for "${query}"`);
  elements.items.innerHTML = merged.map((entry, index) => {
    const title = entry.title;
    const poster = title.posterUrl || '';
    const unavailable = isAuthenticated() && title.playable === false ? '<span class="pill pill-warn">No disponible</span>' : '';
    const typeLabel = title.type === 'series' ? 'Serie' : title.type === 'movie' ? 'Película' : String(title.type || '');
    const startYear = title.year ?? '';
    const endYear = title.type === 'series' ? (title.metadata?.endYear ?? '') : '';
    const yearLabel = endYear && startYear ? `${startYear}-${endYear}` : (startYear || '');
    return `<article class="item" data-key="${escapeHtml(title.catalogKey)}" ${entry.source === 'remote' ? `data-remote-index="${index}"` : ''}>
      ${poster ? `<img class="item-poster" src="${escapeAttribute(poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="item-poster placeholder"></div>'}
      ${getCardQuickActions(title, prefs)}
      <div><strong>${escapeHtml(title.title)}</strong>${unavailable}<span class="meta">${escapeHtml([typeLabel, yearLabel].filter(Boolean).join(' | '))}</span></div>
    </article>`;
  }).join('') || '<div class="empty">No results found for this query.</div>';

  elements.items.querySelectorAll('[data-remote-index]').forEach((item) => {
    item.addEventListener('click', () => {
      const remote = merged[Number(item.dataset.remoteIndex)]?.title;
      if (!remote) return;
      queueCatalogSeedSyncForTitle(remote);
      state.selected = remote;
      state.seriesEpisodes = null;
      state.seriesEpisodesLoading = isAuthenticated() && isSeriesLike(state.selected);
      state.hydratedProgressId = '';
      renderRemoteResults(elements.search.value.trim());
      renderDetail();
      if (isAuthenticated() && isSeriesLike(state.selected)) loadSeriesEpisodes().then(renderDetail);
      syncRoute();
      hydrateSelectedFromTmdb().then(() => renderDetail({ skipHydratePlayback: true }));
    });
  });
  bindLocalCardEvents();
}

function getSortMode() {
  return elements.sortFilter?.value || 'relevance';
}

function setCatalogCount(baseText) {
  const text = String(baseText || '');
  state.lastCountLabel = text;
  const searching = state.isSearching && elements.search.value.trim().length >= 3;
  if (!searching) {
    elements.count.textContent = text;
    return;
  }
  const term = String(state.searchingTerm || elements.search.value || '').trim();
  const label = term ? `Buscando "${term}"...` : 'Buscando...';
  elements.count.innerHTML = `${escapeHtml(text)} <span class="count-searching" aria-live="polite"><span class="count-pulse" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

function sortTitles(titles) {
  const mode = getSortMode();
  const items = [...titles];
  const watch = buildWatchInsights();
  if (mode === 'az') return items.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'es', { sensitivity: 'base' }));
  if (mode === 'za') return items.sort((a, b) => String(b.title || '').localeCompare(String(a.title || ''), 'es', { sensitivity: 'base' }));
  if (mode === 'year_desc') return items.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
  if (mode === 'year_asc') return items.sort((a, b) => {
    const ay = Number(a.year) || 0;
    const by = Number(b.year) || 0;
    if (!ay && !by) return 0;
    if (!ay) return 1;
    if (!by) return -1;
    return ay - by;
  });
  if (mode === 'most_watched') return items.sort((a, b) => (watch.scores[getTitleId(b)] || 0) - (watch.scores[getTitleId(a)] || 0));
  if (mode === 'recommended') return items.sort((a, b) => recommendationScore(b, watch) - recommendationScore(a, watch));
  return items;
}

function sortResultEntries(entries) {
  const mode = getSortMode();
  if (mode === 'relevance') return entries;
  const watch = buildWatchInsights();
  const items = [...entries];
  if (mode === 'az') return items.sort((a, b) => String(a.title?.title || '').localeCompare(String(b.title?.title || ''), 'es', { sensitivity: 'base' }));
  if (mode === 'za') return items.sort((a, b) => String(b.title?.title || '').localeCompare(String(a.title?.title || ''), 'es', { sensitivity: 'base' }));
  if (mode === 'year_desc') return items.sort((a, b) => (Number(b.title?.year) || 0) - (Number(a.title?.year) || 0));
  if (mode === 'year_asc') return items.sort((a, b) => {
    const ay = Number(a.title?.year) || 0;
    const by = Number(b.title?.year) || 0;
    if (!ay && !by) return 0;
    if (!ay) return 1;
    if (!by) return -1;
    return ay - by;
  });
  if (mode === 'most_watched') return items.sort((a, b) => (watch.scores[getTitleId(b.title)] || 0) - (watch.scores[getTitleId(a.title)] || 0));
  if (mode === 'recommended') return items.sort((a, b) => recommendationScore(b.title, watch) - recommendationScore(a.title, watch));
  return items;
}

function buildWatchInsights() {
  const scores = {};
  const genreWeights = {};
  const actorWeights = {};
  const continueIds = new Set();
  const completedIds = new Set();
  const recentAt = {};
  const catalog = loadLocalCatalog();
  const byId = {};
  const aliasesById = {};
  const registerAlias = (a, b) => {
    const x = String(a || '').trim();
    const y = String(b || '').trim();
    if (!x || !y || x === y) return;
    aliasesById[x] = aliasesById[x] || new Set();
    aliasesById[y] = aliasesById[y] || new Set();
    aliasesById[x].add(y);
    aliasesById[y].add(x);
  };
  for (const title of catalog) {
    const id = getTitleId(title);
    if (id) byId[id] = title;
    registerAlias(title?.imdbId, title?.tmdbId);
  }
  const ensureCatalogEntryByHistory = (id, event) => {
    const key = String(id || '').trim();
    if (!key || byId[key]) return;
    const imdbId = String(event?.imdbId || '').trim();
    const tmdbId = String(event?.tmdbId || '').trim();
    const entry = {
      catalogKey: `${String(event?.type || 'movie').trim() || 'movie'}:${imdbId ? 'imdb' : 'tmdb'}:${imdbId || tmdbId}`,
      type: String(event?.type || 'movie').trim() || 'movie',
      imdbId,
      tmdbId,
      title: String(event?.title || (imdbId || tmdbId || key)).trim(),
      year: null,
      description: 'Sincronizado desde historial',
      posterUrl: '',
      playable: true,
      metadata: { releaseDate: null, genres: [], backdropUrl: null, watchProviders: { region: '', flatrate: [] } }
    };
    byId[key] = entry;
    saveLocalCatalog(dedupe([...loadLocalCatalog(), entry], { consolidateEquivalent: true }));
  };
  const markProgress = (id, payload) => {
    const key = String(id || '').trim();
    if (!key) return;
    const p = Number(payload?.progress || 0);
    const isCompleted = Boolean(payload?.isCompleted);
    const forceContinue = Boolean(payload?.forceContinue);
    const updatedAt = Number(payload?.updatedAt || 0);
    if (updatedAt > (recentAt[key] || 0)) recentAt[key] = updatedAt;
    if (isCompleted) completedIds.add(key);
    else if (forceContinue || p > 0) continueIds.add(key);
    const linked = aliasesById[key];
    if (linked) {
      for (const alt of linked) {
        if (updatedAt > (recentAt[alt] || 0)) recentAt[alt] = updatedAt;
        if (isCompleted) completedIds.add(alt);
        else if (forceContinue || p > 0) continueIds.add(alt);
      }
    }
  };

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i) || '';
    if (!key.startsWith('mep_series_progress_')) continue;
    const id = key.replace('mep_series_progress_', '');
    const data = safeJson(localStorage.getItem(key));
    const watched = data?.watched || {};
    let score = 0;
    let totalEntries = 0;
    let completedEntries = 0;
    for (const record of Object.values(watched)) {
      if (record === true) { score += 1; totalEntries += 1; completedEntries += 1; continue; }
      if (!record || typeof record !== 'object') continue;
      totalEntries += 1;
      if (record.completedAt) completedEntries += 1;
      score += record.completedAt ? 1.5 : 0.5;
      score += Number(record.lastProgress || 0) / 120;
    }
    if (score <= 0) continue;
    scores[id] = (scores[id] || 0) + score;
    const localUpdatedAt = Date.parse(data?.updatedAt || 0) || 0;
    if (localUpdatedAt > (recentAt[id] || 0)) recentAt[id] = localUpdatedAt;
    const completedLocal = totalEntries > 0 && completedEntries === totalEntries;
    if (completedLocal) completedIds.add(id);
    else continueIds.add(id);
    const title = byId[id];
    const genres = title?.metadata?.genres || [];
    const cast = title?.metadata?.cast || [];
    for (const g of genres) genreWeights[g] = (genreWeights[g] || 0) + score;
    for (const c of cast.slice(0, 8)) actorWeights[c] = (actorWeights[c] || 0) + score;
  }

  const authUser = getAuthUser();
  const synced = authUser?.email ? loadSyncedWatchProgress(authUser.email) : null;
  const remoteProgress = synced?.progress && typeof synced.progress === 'object' ? synced.progress : {};
  const historyById = {};
  for (const event of Array.isArray(synced?.history) ? synced.history : []) {
    const id = String(event?.imdbId || event?.tmdbId || '').trim();
    if (!id) continue;
    const prev = historyById[id];
    const at = Date.parse(event?.updatedAt || 0) || 0;
    if (!prev || at > (Date.parse(prev.updatedAt || 0) || 0)) historyById[id] = event;
  }
  for (const [id, entry] of Object.entries(remoteProgress)) {
    if (!entry || typeof entry !== 'object') continue;
    const p = Number(entry.lastProgress ?? entry.progress ?? 0);
    const lastEvent = historyById[id];
    const status = String(lastEvent?.playerStatus || '').trim().toLowerCase();
    const forceContinue = status === 'playing' || status === 'paused' || status === 'seeked';
    const isPercentScale = p >= 0 && p <= 100;
    const isCompleted = status === 'completed' || (isPercentScale && p >= 95);
    const updatedAt = Date.parse(entry.updatedAt || 0) || 0;
    scores[id] = Math.max(scores[id] || 0, 0.75 + (p / 120));
    const imdb = String(entry?.imdbId || '').trim();
    const tmdb = String(entry?.tmdbId || '').trim();
    registerAlias(imdb, tmdb);
    markProgress(id, { progress: p, isCompleted, forceContinue, updatedAt });
    if (imdb && imdb !== id) markProgress(imdb, { progress: p, isCompleted, forceContinue, updatedAt });
    if (tmdb && tmdb !== id) markProgress(tmdb, { progress: p, isCompleted, forceContinue, updatedAt });
  }

  // Authoritative correction by latest history event:
  // last "playing" => continue, last "completed" => rewatch.
  for (const [id, event] of Object.entries(historyById)) {
    const status = String(event?.playerStatus || '').trim().toLowerCase();
    const updatedAt = Date.parse(event?.updatedAt || 0) || 0;
    ensureCatalogEntryByHistory(id, event);
    if (status === 'playing' || status === 'paused' || status === 'seeked') {
      completedIds.delete(id);
      continueIds.add(id);
      scores[id] = Math.max(scores[id] || 0, 0.5);
      if (updatedAt > (recentAt[id] || 0)) recentAt[id] = updatedAt;
    } else if (status === 'completed') {
      continueIds.delete(id);
      completedIds.add(id);
      if (updatedAt > (recentAt[id] || 0)) recentAt[id] = updatedAt;
    }
    const linked = aliasesById[id];
    if (linked) {
      for (const alt of linked) {
        if (status === 'playing' || status === 'paused' || status === 'seeked') {
          completedIds.delete(alt);
          continueIds.add(alt);
        } else if (status === 'completed') {
          continueIds.delete(alt);
          completedIds.add(alt);
        }
        if (updatedAt > (recentAt[alt] || 0)) recentAt[alt] = updatedAt;
      }
    }
  }

  const lastWatch = safeJson(localStorage.getItem('mep_last_watch'));
  if (lastWatch) {
    const id = lastWatch.imdbId || lastWatch.tmdbId;
    const key = String(id || '').trim();
    if (key) {
      const syncedEntry = remoteProgress[key];
      const syncedProgress = Number(syncedEntry?.lastProgress ?? syncedEntry?.progress ?? 0);
      const completed = syncedProgress >= 95;
      if (!completed) continueIds.add(key);
      if (completed) completedIds.add(key);
      scores[key] = (scores[key] || 0) + (completed ? 0 : 2);
      recentAt[key] = Math.max(recentAt[key] || 0, Date.now());
    }
  }
  return { scores, genreWeights, actorWeights, continueIds, completedIds, recentAt };
}

function recommendationScore(title, watch) {
  const id = getTitleId(title);
  const watchBoost = watch.scores[id] || 0;
  const genres = title?.metadata?.genres || [];
  const cast = title?.metadata?.cast || [];
  let score = watchBoost * 2;
  for (const g of genres) score += watch.genreWeights[g] || 0;
  for (const c of cast.slice(0, 8)) score += (watch.actorWeights[c] || 0) * 0.5;
  if (title.posterUrl) score += 1;
  if (title.type === 'series') score += 0.25;
  return score;
}

function safeJson(text) {
  try { return JSON.parse(text || 'null'); } catch { return null; }
}

function getCurrentUserPrefsKey() {
  const user = getAuthUser();
  const email = String(user?.email || '').trim().toLowerCase();
  return email ? `${TITLE_PREFS_STORAGE_PREFIX}${email}` : '';
}

function loadTitlePrefs() {
  const key = getCurrentUserPrefsKey();
  if (!key) return { likes: {}, watchLater: {} };
  const data = safeJson(localStorage.getItem(key)) || {};
  return {
    likes: data.likes && typeof data.likes === 'object' ? data.likes : {},
    watchLater: data.watchLater && typeof data.watchLater === 'object' ? data.watchLater : {}
  };
}

function saveTitlePrefs(next) {
  const key = getCurrentUserPrefsKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify({
    likes: next?.likes || {},
    watchLater: next?.watchLater || {},
    updatedAt: new Date().toISOString()
  }));
}

function getTitleFlags(title, prefs = loadTitlePrefs()) {
  const id = getTitleId(title);
  if (!id) return { like: 0, watchLater: false };
  return {
    like: Number(prefs?.likes?.[id] || 0),
    watchLater: Boolean(prefs?.watchLater?.[id])
  };
}

function getCardQuickActions(title, prefs = loadTitlePrefs()) {
  if (!isAuthenticated()) return '';
  const prefId = escapeAttribute(String(getTitleId(title) || ''));
  const flags = getTitleFlags(title, prefs);
  const likedClass = flags.like === 1 ? ' active-like' : '';
  const laterClass = flags.watchLater ? ' active-later' : '';
  return `<div class="item-quick-actions">
    <button class="item-quick-btn${likedClass}" type="button" data-pref-id="${prefId}" data-quick-action="like" aria-label="Me gusta">❤</button>
    <button class="item-quick-btn${laterClass}" type="button" data-pref-id="${prefId}" data-quick-action="later" aria-label="Ver mas tarde">+</button>
  </div>`;
}

function updateQuickActionButtons(prefId) {
  const id = String(prefId || '').trim();
  if (!id) return;
  const prefs = loadTitlePrefs();
  const likeActive = Number(prefs?.likes?.[id] || 0) === 1;
  const laterActive = Boolean(prefs?.watchLater?.[id]);
  document.querySelectorAll(`.item-quick-btn[data-pref-id="${CSS.escape(id)}"][data-quick-action="like"]`)
    .forEach((btn) => btn.classList.toggle('active-like', likeActive));
  document.querySelectorAll(`.item-quick-btn[data-pref-id="${CSS.escape(id)}"][data-quick-action="later"]`)
    .forEach((btn) => btn.classList.toggle('active-later', laterActive));
}

function isSeriesCompletedByLastEpisode(title) {
  if (!isSeriesLike(title)) return false;
  const sourceId = String(title?.imdbId || title?.tmdbId || '').trim();
  if (!sourceId) return false;
  const progress = getSeriesProgress(title);
  const cached = loadCachedSeriesEpisodes(sourceId);
  const seasons = Array.isArray(cached?.seasons) ? cached.seasons : [];
  if (!seasons.length) return false;
  const lastSeason = seasons[seasons.length - 1];
  const lastEpisode = Array.isArray(lastSeason?.episodes) && lastSeason.episodes.length
    ? lastSeason.episodes[lastSeason.episodes.length - 1]
    : null;
  if (!lastEpisode) return false;
  const entry = progress?.watched?.[`s${lastSeason.seasonNumber}e${lastEpisode.episode}`];
  if (entry === true) return true;
  return Boolean(entry?.completedAt);
}

function cleanupWatchLaterFromCompleted(baseFiltered = null) {
  if (!isAuthenticated()) return;
  const prefs = loadTitlePrefs();
  const current = { ...(prefs.watchLater || {}) };
  const watch = buildWatchInsights();
  const titles = Array.isArray(baseFiltered) ? baseFiltered : getFilteredLocalTitles();
  let changed = false;
  for (const title of titles) {
    const id = getTitleId(title);
    if (!id || !current[id]) continue;
    const completed = watch.completedIds.has(id) || isSeriesCompletedByLastEpisode(title);
    if (!completed) continue;
    delete current[id];
    changed = true;
  }
  if (changed) saveTitlePrefs({ ...prefs, watchLater: current });
}

function setTitlePreference(title, action) {
  if (!isAuthenticated() || !title) return;
  const id = getTitleId(title);
  if (!id) return;
  const prefs = loadTitlePrefs();
  const next = {
    likes: { ...(prefs.likes || {}) },
    watchLater: { ...(prefs.watchLater || {}) }
  };
  if (action === 'like') next.likes[id] = next.likes[id] === 1 ? 0 : 1;
  else if (action === 'later') {
    if (next.watchLater[id]) delete next.watchLater[id];
    else next.watchLater[id] = true;
  }
  if (!next.likes[id]) delete next.likes[id];
  saveTitlePrefs(next);
  void queueTitlePreferenceSync(title, action, {
    liked: next.likes[id] === 1,
    watchLater: Boolean(next.watchLater[id])
  });
}

async function queueTitlePreferenceSync(title, action, stateFlags) {
  const user = getAuthUser();
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email || !title || !['like', 'later'].includes(String(action || ''))) return;
  const titleId = String(title?.imdbId || title?.tmdbId || '').trim();
  if (!titleId) return;
  const issueBody = [
    'WATCH_PROGRESS_SYNC_REQUEST',
    `Email: ${email}`,
    `Name: ${String(user?.name || '').trim()}`,
    `IMDb: ${String(title.imdbId || '').trim()}`,
    `TMDB: ${String(title.tmdbId || '').trim()}`,
    'Season: 1',
    'Episode: 1',
    'Progress: 0',
    `Title: ${String(title.title || '').trim()}`,
    `Type: ${String(title.type || '').trim()}`,
    'PlayerStatus: preference',
    `PreferenceAction: ${String(action).trim()}`,
    `PreferenceValue: ${action === 'like' ? (stateFlags?.liked ? 'liked' : 'none') : (stateFlags?.watchLater ? 'saved' : 'none')}`,
    `ClientUpdatedAt: ${new Date().toISOString()}`
  ].join('\n');
  try {
    await openGitHubIssue(`Preference sync: ${title.title || titleId}`, issueBody, [WATCH_PROGRESS_SYNC_LABEL]);
  } catch {
    // Keep local preference toggle even if issue sync fails.
  }
}

function renderDetail(options = {}) {
  const { skipHydratePlayback = false } = options;
  const title = state.selected;
  if (!title) {
    document.body.classList.remove('detail-active');
    if (elements.detail) {
      elements.detail.hidden = true;
      elements.detail.innerHTML = '';
    }
    return;
  }

  document.body.classList.add('detail-active');
  if (elements.detail) elements.detail.hidden = false;

  if (!isAuthenticated()) {
    const poster = title.posterUrl || '';
    const isBareRoute = (title.description === 'Cargado desde ruta') || (title.title === (title.imdbId || title.tmdbId));
    elements.detail.innerHTML = `<div class="detail-inner overlay-open">
      <button class="back-chip" id="closeDetail" aria-label="Volver al inicio">
        <span class="back-chip-icon" aria-hidden="true">←</span>
        <span class="back-chip-label">Inicio</span>
      </button>
      <section class="title-hero">
        <div class="title-hero-bg" aria-hidden="true" style="${poster ? `--poster: url('${escapeAttribute(poster)}')` : ''}"></div>
        <div class="title-copy">
          <span class="pill">${escapeHtml(title.type)}</span>
          <h2>${escapeHtml(title.title)}</h2>
          ${getCardQuickActions(title)}
          <p class="title-meta">${escapeHtml([title.year].filter(Boolean).join(' | '))}</p>
          <p class="title-description">${escapeHtml(title.description || 'Información no disponible.')}</p>
          ${isBareRoute ? '<p class="title-description">Metadata no disponible para este ID. Busca por nombre para obtener información.</p>' : ''}
          ${renderEvaluationPanel(title)}
        </div>
      </section>
    </div>`;

    document.querySelector('#closeDetail')?.addEventListener('click', () => {
      state.selected = null;
      state.seriesEpisodes = null;
      document.body.classList.remove('detail-active');
      renderCatalog();
      renderDetail();
      syncRoute();
    });

    bindEvaluationPanel(title);
    return;
  }

  const baseEmbed = buildEmbedUrl(title);
  state.playback.season = title.season || state.playback.season || 1;
  state.playback.episode = title.episode || state.playback.episode || 1;
  if (!skipHydratePlayback) applySavedWatchState(title);
  const poster = title.posterUrl || '';
  const progress = getSeriesProgress(title);
  const genres = (title.metadata?.genres ?? []).filter(Boolean);
  const castNames = (title.metadata?.cast ?? []).filter(Boolean);
  const hasEpisodes = isSeriesLike(title) && (state.seriesEpisodes?.seasons?.length ?? 0) > 0;
  const hasWatchHistory = Boolean(Object.keys(progress?.watched ?? {}).length) || Boolean(progress?.lastSeason && progress?.lastEpisode);
  const resumeTarget = hasEpisodes ? getResumeTarget(progress, state.seriesEpisodes) : null;
  const startTarget = hasEpisodes ? getStartTarget(state.seriesEpisodes) : null;
  const isPlayable = title.playable !== false;
  const seasonsTabs = hasEpisodes ? state.seriesEpisodes.seasons.map((entry) => `<button class="season-tab${entry.seasonNumber === state.playback.season ? ' active' : ''}" data-season="${entry.seasonNumber}">T${entry.seasonNumber}</button>`).join('') : '';
  const episodeCards = hasEpisodes ? getEpisodesForSeason(state.playback.season).map((entry) => {
    const watched = isEpisodeWatched(progress, state.playback.season, entry.episode);
    const inProgress = isEpisodeInProgress(progress, state.playback.season, entry.episode);
    return `<article class="episode-card${watched ? ' watched' : ''}${state.playback.episode === entry.episode ? ' current' : ''}" data-episode="${entry.episode}" role="button" tabindex="0">
      <div class="episode-copy">
        <span class="episode-code">E${entry.episode}</span>
        <span class="episode-title">${escapeHtml(entry.title || `Episode ${entry.episode}`)}</span>
        ${watched ? '<span class="episode-status">Visto</span>' : ''}
      </div>
      <button class="episode-play-btn" type="button" data-episode-play="${entry.episode}">
        ${inProgress ? 'Continuar' : 'Play'}
      </button>
    </article>`;
  }).join('') : '';

  const availabilityBlock = isPlayable ? '' : `<div class="availability">
    <div class="availability-copy">
      <strong>No disponible en el momento</strong>
      <span>Este título existe, pero no está disponible para reproducir con la fuente actual.</span>
    </div>
    <button id="requestTitle" type="button">Solicitar</button>
  </div>`;
  const issueActionLabel = isSeriesLike(title) ? 'Solucionar capítulos faltantes' : 'Reportar problema';

  const isBareRoute = (title.description === 'Cargado desde ruta') || (title.title === (title.imdbId || title.tmdbId));
  const metadataBlock = isBareRoute ? `<div class="availability">
    <div class="availability-copy">
      <strong>Metadata no disponible</strong>
      <span>Este ID no devolvió poster/descripcion en las fuentes actuales. Prueba buscar por nombre.</span>
    </div>
    <button id="requestMetadata" type="button">Solicitar</button>
  </div>` : '';

  elements.detail.innerHTML = `<div class="detail-inner overlay-open">
    <button class="back-chip" id="closeDetail" aria-label="Volver al inicio">
      <span class="back-chip-icon" aria-hidden="true">←</span>
      <span class="back-chip-label">Inicio</span>
    </button>
    <section class="title-hero">
      <div class="title-hero-bg" aria-hidden="true" style="${poster ? `--poster: url('${escapeAttribute(poster)}')` : ''}"></div>
      <div class="title-copy">
        <span class="pill">${escapeHtml(title.type)}</span>
        <h2>${escapeHtml(title.title)}</h2>
        ${getCardQuickActions(title)}
        <p class="title-meta">${escapeHtml([title.year, genres.length ? genres.slice(0, 3).join(', ') : ''].filter(Boolean).join(' | '))}</p>
        <p class="title-description">${escapeHtml(title.description || 'Información no disponible.')}</p>
        ${castNames.length ? `<p class="title-meta">${escapeHtml(`Cast: ${castNames.slice(0, 6).join(', ')}`)}</p>` : ''}
        ${metadataBlock}
        ${availabilityBlock}
        <div class="actions hero-actions">
          ${!isSeriesLike(title) ? `<button id="loadPlayer"${isPlayable ? '' : ' disabled'}>${isPlayable ? 'Play' : 'No disponible'}</button>` : ''}
          ${isSeriesLike(title) && !hasWatchHistory && startTarget ? `<button id="startSeries">Play T${startTarget.season}E${startTarget.episode}</button>` : ''}
          ${isSeriesLike(title) && hasWatchHistory && resumeTarget ? `<button id="resumeSeries">${escapeHtml(resumeTarget.label)}</button>` : ''}
          <button id="reportIssue" type="button">${escapeHtml(issueActionLabel)}</button>
          ${isSeriesLike(title) && isAuthenticated() ? `<button id="refreshEpisodes"${state.seriesEpisodesLoading ? ' disabled' : ''}>Actualizar capítulos</button>` : ''}
        </div>
      </div>
    </section>
    ${isSeriesLike(title) ? `<section class="seasons-panel"><div class="seasons-tabs">${seasonsTabs || `<span class="episode-hint">${state.seriesEpisodesLoading ? 'Cargando temporadas...' : 'No se encontraron temporadas.'}</span>`}</div><div class="episodes-grid">${episodeCards || `<span class="episode-hint">${state.seriesEpisodesLoading ? 'Cargando capítulos...' : 'No se encontraron capítulos.'}</span>`}</div></section>` : ''}
  </div>`;

  bindTap(document.querySelector('#loadPlayer'), () => {
    if (!isPlayable) return;
    openPlayerForCurrentSelection();
  });
  bindTap(document.querySelector('#startSeries'), () => {
    state.playback.season = startTarget.season;
    state.playback.episode = startTarget.episode;
    openPlayerForCurrentSelection();
  });
  bindTap(document.querySelector('#resumeSeries'), () => {
    state.playback.season = resumeTarget.season;
    state.playback.episode = resumeTarget.episode;
    openPlayerForCurrentSelection();
  });
  bindTap(document.querySelector('#refreshEpisodes'), async () => {
    const cacheId = state.selected?.imdbId || state.selected?.tmdbId || '';
    if (!cacheId) return;
    try { localStorage.removeItem(`mep_series_eps_${cacheId}`); } catch {}
    episodeIndexPromise = null;
    state.seriesEpisodes = null;
    state.seriesEpisodesLoading = true;
    renderDetail({ skipHydratePlayback: true });
    await loadSeriesEpisodes({ forceRefresh: true });
    renderDetail({ skipHydratePlayback: true });
  });
  bindTap(document.querySelector('#requestTitle'), () => {
    const id = title.imdbId || title.tmdbId || '';
    const type = title.type || 'unknown';
    const label = title.title || id || 'Title request';
    const issueTitle = `Title request: ${label} (${type})`;
    const issueBody = [
      'Requesting availability for:',
      `- title: ${label}`,
      `- type: ${type}`,
      id ? `- id: ${id}` : '',
      '',
      'Seen in static app but not playable with current source.',
      '',
      `Page: ${window.location.href}`
    ].filter(Boolean).join('\n');
    void openGitHubIssue(issueTitle, issueBody).then((issue) => {
      void notifyIssueCreated(issue);
    }).catch((error) => {
      console.error(error);
      void notifyIssueCreationError(error);
    });
  });
  bindTap(document.querySelector('#requestMetadata'), () => {
    const id = title.imdbId || title.tmdbId || '';
    const type = title.type || 'unknown';
    const label = title.title || id || 'Metadata request';
    void openGitHubIssue(`Metadata request: ${label} (${type})`, buildIssueBody(title, [
      'Requesting metadata for this title.',
      '',
      'Context:',
      `- opened via direct route or missing metadata in current sources`
    ])).then((issue) => {
      void notifyIssueCreated(issue);
    }).catch((error) => {
      console.error(error);
      void notifyIssueCreationError(error);
    });
  });
  bindTap(document.querySelector('#reportIssue'), () => {
    if (!isSeriesLike(title)) {
      const id = title.imdbId || title.tmdbId || '';
      const type = title.type || 'unknown';
      const label = title.title || id || 'Title issue';
      void openGitHubIssue(`Report: ${label} (${type})`, buildIssueBody(title, [
        'Describe the problem here:',
        '- no links',
        '- playback fails',
        '- chapters missing',
        '- metadata wrong',
        '',
        'Observed issue:',
        '',
        'Expected behavior:',
        ''
      ]), ['episode-sync']).then((issue) => {
        void notifyIssueCreated(issue);
      }).catch((error) => {
        console.error(error);
        void notifyIssueCreationError(error);
      });
      return;
    }
    const label = title.title || title.imdbId || title.tmdbId || 'Title issue';
    const type = title.type || 'unknown';
    const seasons = Array.isArray(state.seriesEpisodes?.seasons) ? state.seriesEpisodes.seasons.length : 0;
    const episodeTotal = Array.isArray(state.seriesEpisodes?.seasons)
      ? state.seriesEpisodes.seasons.reduce((count, season) => count + (season?.episodes?.length || 0), 0)
      : 0;
    const chaptersListed = seasons > 0 ? 'yes' : 'no';
    const button = document.querySelector('#reportIssue');
    if (button) button.disabled = true;
    void openGitHubIssue(`Solution request: missing episodes for ${label} (${type})`, buildIssueBody(title, [
      'Problem type: missing episodes',
      '',
      'Episode status:',
      `- Chapters listed in app: ${chaptersListed}`,
      `- Seasons loaded: ${seasons}`,
      `- Episodes loaded: ${episodeTotal}`,
      `- Episode asset present: ${episodeTotal > 0 ? 'yes' : 'no'}`,
      '',
      'Observed issue:',
      'Series opens but chapters are missing or incomplete.',
      '',
      'Expected behavior:',
      'Series should list the available seasons and episodes after sync.',
      '',
      'Action requested:',
      'Sync missing episode assets from the public source and mark the issue as resolved.',
      ''
    ]), ['episode-sync']).then((issue) => {
      void notifyIssueCreated({ reloadMs: 60000 });
    }).catch((error) => {
      console.error(error);
      if (button) button.disabled = false;
      void notifyIssueCreationError(error);
    });
  });
  document.querySelector('#closeDetail')?.addEventListener('click', () => {
    state.selected = null;
    state.seriesEpisodes = null;
    document.body.classList.remove('detail-active');
    renderCatalog();
    renderDetail();
    syncRoute();
  });
  document.querySelectorAll('[data-season]').forEach((button) => button.addEventListener('click', () => { state.playback.season = positiveInteger(button.dataset.season, 1); renderDetail(); syncRoute(); }));
  document.querySelectorAll('[data-episode]').forEach((button) => {
    const onSelect = (playNow = false) => {
      state.playback.episode = positiveInteger(button.dataset.episode, 1);
      if (playNow) {
        openPlayerForCurrentSelection();
        return;
      }
      renderDetail();
      syncRoute();
    };
    // Direct episode jump: clicking an episode starts playback immediately.
    button.addEventListener('click', () => onSelect(true));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onSelect(true);
    });
  });

  document.querySelectorAll('[data-episode-play]').forEach((playBtn) => bindTap(playBtn, (event) => {
    // Prevent the click from also selecting the parent episode card.
    event?.stopPropagation?.();
    const episode = positiveInteger(playBtn.dataset.episodePlay, 1);
    state.playback.episode = episode;
    openPlayerForCurrentSelection();
  }));
}

function openPlayerModal(embedUrl) {
  if (state.playerOpening) return;
  state.playerOpening = true;
  clearPlayerFallback();
  persistLastSelection();
  const modal = elements.playerModal;
  const card = modal?.querySelector('.player-modal-card');
  const iframe = elements.playerIframe;
  if (!modal || !iframe || !card) {
    state.playerOpening = false;
    return;
  }

  renderPlayerControls();
  iframe.src = embedUrl;
  schedulePlayerFallback(getPlaybackUrlsForCurrentSelection(embedUrl));
  modal.hidden = false;
  document.body.classList.add('player-active');
  requestNativeFullscreen(card);
  state.playerOpening = false;
  syncRoute();
}

function closePlayerModal() {
  const modal = elements.playerModal;
  const iframe = elements.playerIframe;
  if (!modal || !iframe) return;
  clearPlayerFallback();
  modal.hidden = true;
  iframe.src = 'about:blank';
  document.body.classList.remove('player-active');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  syncRoute();
}

function openPlayerForCurrentSelection() {
  if (isAdminUser()) return;
  if (!isAuthenticated()) {
    showAuthGate();
    return;
  }
  const modal = elements.playerModal;
  if (modal && !modal.hidden) return;
  if (!state.selected) return;
  const id = state.selected.imdbId || state.selected.tmdbId;
  const media = state.selected.type === 'movie' ? 'movie' : 'series';
  if (!id) return;

  // Keep hash route in sync with the intended playback target.
  let path = '';
  if (media === 'movie') {
    path = `/view/movie/${encodeURIComponent(id)}`;
  } else {
    path = `/view/series/${encodeURIComponent(id)}/${state.playback.season || 1}/${state.playback.episode || 1}`;
  }
  window.location.hash = `#${path}`;
}

function jumpEpisode(direction, baseEmbed) {
  if (!isSeriesLike(state.selected)) return;
  const episodes = getEpisodesForSeason(state.playback.season);
  const currentIndex = episodes.findIndex((entry) => entry.episode === state.playback.episode);

  if (currentIndex >= 0) {
    const target = episodes[currentIndex + direction];
    if (target) {
      state.playback.episode = target.episode;
      openPlayerModal(getCurrentEmbedUrl(baseEmbed));
      return;
    }
  }

  if (direction > 0) {
    const nextSeason = state.playback.season + 1;
    const first = getEpisodesForSeason(nextSeason)[0];
    if (!first) return;
    state.playback.season = nextSeason;
    state.playback.episode = first.episode;
  } else {
    const previousSeason = state.playback.season - 1;
    if (previousSeason < 1) return;
    const previousEpisodes = getEpisodesForSeason(previousSeason);
    const last = previousEpisodes[previousEpisodes.length - 1];
    if (!last) return;
    state.playback.season = previousSeason;
    state.playback.episode = last.episode;
  }

  openPlayerModal(getCurrentEmbedUrl(baseEmbed));
}

async function searchViaListingsAndImdb(query, typeFilter) {
  const fromListings = await searchVidapiListings(query, typeFilter);
  const fromImdb = await searchImdbSuggestionsViaJina(query, typeFilter);
  return [...fromListings, ...fromImdb];
}

async function searchVidapiListings(query, typeFilter) {
  const normalizedQuery = query.trim().toLowerCase();
  const kinds = typeFilter === 'movie' ? ['movie'] : typeFilter === 'series' ? ['series'] : ['movie', 'series'];
  const results = [];
  for (const kind of kinds) {
    for (let page = 1; page <= 12; page++) {
      const endpoint = kind === 'movie' ? `https://vidapi.ru/movies/latest/page-${page}.json` : `https://vidapi.ru/tvshows/latest/page-${page}.json`;
      const response = await fetchWithTimeout(endpoint, {
        headers: { accept: 'application/json' }
      }, 4500).catch(() => null);
      if (!response?.ok) break;
      const data = await response.json();
      for (const item of data.items ?? []) {
        const normalized = kind === 'movie'
          ? { imdbId: item.imdb_id || '', tmdbId: String(item.tmdb_id ?? ''), title: item.title || '', year: Number(item.year) || null, type: 'movie', posterUrl: item.poster_url || '', description: item.genre || '' }
          : { imdbId: item.imdb_id || '', tmdbId: String(item.tmdb_id ?? ''), title: item.title || '', year: Number(item.year) || null, type: 'series', posterUrl: item.poster_url || '', description: item.genre || '' };
        const haystack = [normalized.title, normalized.description, normalized.imdbId].join(' ').toLowerCase();
        if (haystack.includes(normalizedQuery)) results.push(normalized);
      }
      await sleep(50);
    }
  }
  return results;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchImdbSuggestionsViaJina(query, typeFilter) {
  const normalized = query
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const bucket = normalized[0] || 'x';
  const response = await fetch(`https://r.jina.ai/http://v3.sg.media-imdb.com/suggestion/${encodeURIComponent(bucket)}/${encodeURIComponent(normalized)}.json`);
  if (!response.ok) return [];
  const text = await response.text();
  const start = text.indexOf('{');
  if (start === -1) return [];
  let payload;
  try { payload = JSON.parse(text.slice(start)); } catch { return []; }
  return (payload.d ?? [])
    .filter((item) => item.id?.startsWith('tt'))
    .map((item) => {
      const qid = String(item.qid || '');
      const q = String(item.q || '');
      const isSeries = qid.toLowerCase().includes('tv') || q.toLowerCase().includes('tv');
      return { imdbId: item.id, tmdbId: '', title: item.l || '', year: Number(item.y) || null, type: isSeries ? 'series' : 'movie', posterUrl: item.i?.imageUrl || '', description: item.s || '' };
    })
    .filter((result) => typeFilter === 'all' || result.type === typeFilter);
}

async function loadSeriesEpisodes(options = {}) {
  const { forceRefresh = false } = options;
  if (!state.selected || !isSeriesLike(state.selected)) return;
  state.seriesEpisodesLoading = true;
  try {
    const imdbId = String(state.selected.imdbId || '').trim();
    const tmdbId = String(state.selected.tmdbId || '').trim();
    const cacheId = imdbId || tmdbId;
    if (!cacheId) throw new Error('missing series id');

    if (!forceRefresh) {
      const cached = loadCachedSeriesEpisodes(cacheId);
      if (cached?.seasons?.length) {
        state.seriesEpisodes = cached;
        console.debug('[mep] series episodes loaded from cache', {
          title: state.selected.title,
          imdbId,
          tmdbId,
          seasons: cached.seasons.length
        });
        state.seriesEpisodesLoading = false;
        return;
      }
    }

    let payload = null;
    try {
      const text = await fetchSeriesEpisodeText(imdbId, { forceRefresh });
      payload = buildEpisodesFromIdList(imdbId, text);
      if ((payload?.seasons?.length ?? 0) > 0) {
        console.debug('[mep] series episodes loaded from episode index', {
          title: state.selected.title,
          imdbId,
          tmdbId,
          seasons: payload.seasons.length
        });
      }
    } catch {
      payload = null;
    }

    if ((payload?.seasons?.length ?? 0) === 0) {
      payload = await buildEpisodesFromTmdb(state.selected).catch(() => null);
      if ((payload?.seasons?.length ?? 0) > 0) {
        console.debug('[mep] series episodes loaded from TMDB fallback', {
          title: state.selected.title,
          imdbId,
          tmdbId,
          seasons: payload.seasons.length
        });
      }
    }

    const hasEpisodes = (payload?.seasons?.length ?? 0) > 0;
    if (!hasEpisodes && !forceRefresh) {
      // If episode assets were updated on Pages (e.g. after resolving a "missing episodes" issue),
      // localStorage + HTTP cache can keep us stuck. Retry once with a hard refresh.
      clearEpisodeLookupCaches();
      episodeIndexPromise = null;
      await loadSeriesEpisodes({ forceRefresh: true });
      return;
    }

    state.seriesEpisodes = hasEpisodes ? payload : { seasons: [] };
    if ((state.seriesEpisodes?.seasons?.length ?? 0) > 0) {
      cacheSeriesEpisodes(cacheId, state.seriesEpisodes);
    } else {
      console.warn('[mep] series episodes not found', {
        title: state.selected.title,
        imdbId,
        tmdbId
      });
    }
  } catch {
    state.seriesEpisodes = { seasons: [] };
  } finally {
    state.seriesEpisodesLoading = false;
  }
}

async function filterUnavailableSeries(results) {
  const index = await getEpisodeSeriesIndex();
  if (!index || index.size === 0) return results;
  return results.filter((item) => {
    if (item.type !== 'series') return true;
    const imdbId = String(item.imdbId || '').trim();
    if (!imdbId) return false;
    return index.has(imdbId);
  });
}

async function getEpisodeSeriesIndex() {
  if (episodeIndexPromise) return episodeIndexPromise;

  episodeIndexPromise = (async () => {
    try {
      const manifest = await fetchEpisodeManifest();
      const set = new Set();
      for (const id of Object.keys(manifest?.series || {})) {
        if (/^tt\d+$/i.test(id)) set.add(id);
      }
      return set;
    } catch {
      return new Set();
    }
  })();

  return episodeIndexPromise;
}

function loadEpisodeManifestCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(EPISODE_MANIFEST_CACHE_KEY) || 'null');
    if (!cached || typeof cached !== 'object') return null;
    const createdAt = Number(cached.createdAt || 0);
    const payload = cached.payload;
    if (!createdAt || !payload || typeof payload !== 'object') return null;
    if ((Date.now() - createdAt) > EPISODE_MANIFEST_CACHE_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

function saveEpisodeManifestCache(payload) {
  try {
    localStorage.setItem(EPISODE_MANIFEST_CACHE_KEY, JSON.stringify({
      createdAt: Date.now(),
      payload
    }));
  } catch {}
}

async function fetchEpisodeManifest(options = {}) {
  const { forceRefresh = false } = options;
  if (!forceRefresh) {
    const cached = loadEpisodeManifestCache();
    if (cached) return cached;
    if (episodeManifestPromise) return episodeManifestPromise;
  }

  const cacheBuster = forceRefresh ? `?v=${Date.now()}` : '';
  const request = (async () => {
    const local = await fetchWithTimeout(`./assets/episodes/index.json${cacheBuster}`, {
      headers: { accept: 'application/json' },
      cache: forceRefresh ? 'no-store' : 'default'
    }, 2500).catch(() => null);
    if (!local?.ok) throw new Error('episode manifest unavailable');
    const payload = await local.json();
    if (!forceRefresh) saveEpisodeManifestCache(payload);
    return payload;
  })();

  if (!forceRefresh) episodeManifestPromise = request;

  try {
    return await request;
  } finally {
    if (!forceRefresh) episodeManifestPromise = null;
  }
}

async function fetchSeriesEpisodeText(imdbId, options = {}) {
  const { forceRefresh = false } = options;
  const id = String(imdbId || '').trim();
  if (!id) throw new Error('missing imdb id');
  if (!forceRefresh && episodeTextPromises.has(id)) return episodeTextPromises.get(id);

  const promise = (async () => {
    let fileName = `${id}.txt`;
    try {
      const manifest = await fetchEpisodeManifest({ forceRefresh });
      fileName = String(manifest?.series?.[id]?.file || fileName).trim() || fileName;
    } catch {
      // Fall back to the canonical filename if the manifest is unavailable.
    }

    const cacheBuster = forceRefresh ? `?v=${Date.now()}` : '';
    const local = await fetchWithTimeout(`./assets/episodes/${encodeURIComponent(fileName)}${cacheBuster}`, {
      headers: { accept: 'text/plain' },
      cache: forceRefresh ? 'no-store' : 'default'
    }, 2500).catch(() => null);
    if (local?.ok) {
      const text = await local.text();
      if (String(text || '').trim()) return text;
    }
    throw new Error('series episode file unavailable');
  })();

  episodeTextPromises.set(id, promise);
  try {
    return await promise;
  } finally {
    episodeTextPromises.delete(id);
  }
}

function clearEpisodeLookupCaches() {
  try {
    localStorage.removeItem(EPISODE_MANIFEST_CACHE_KEY);
  } catch {}
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('mep_series_eps_')) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {}
  episodeManifestPromise = null;
  episodeTextPromises.clear();
}

function buildEpisodesFromIdList(imdbId, text) {
  const bySeason = new Map();
  const prefix = `${imdbId}_`;

  for (const line of String(text ?? '').split('\n')) {
    const value = line.trim();
    if (!value.startsWith(prefix)) continue;
    const [seasonRaw, episodeRaw] = value.slice(prefix.length).split('x');
    const season = Number(seasonRaw);
    const episode = Number(episodeRaw);
    if (!Number.isInteger(season) || !Number.isInteger(episode)) continue;
    const entries = bySeason.get(season) ?? [];
    entries.push({ season, episode, title: `Episode ${episode}` });
    bySeason.set(season, entries);
  }

  return {
    seasons: [...bySeason.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seasonNumber, episodes]) => ({
        seasonNumber,
        episodes: episodes.sort((a, b) => a.episode - b.episode)
      }))
  };
}

async function buildEpisodesFromTmdb(title) {
  const token = getTmdbReadToken();
  if (!token) {
    console.debug('[mep] TMDB fallback skipped: missing token', {
      title: title?.title,
      imdbId: title?.imdbId || '',
      tmdbId: title?.tmdbId || ''
    });
    return null;
  }

  let tmdbId = String(title?.tmdbId || '').trim();
  if (!tmdbId && title?.imdbId) {
    try {
      const found = await tmdbFetchJson(`/find/${encodeURIComponent(title.imdbId)}`, {
        external_source: 'imdb_id',
        language: 'es-ES'
      });
      const pick = found.tv_results?.[0] || null;
      if (pick?.id) tmdbId = String(pick.id);
    } catch {
      // Fall through to title search.
    }
  }

  if (!tmdbId && title?.title) {
    try {
      const query = String(title.title || '').trim();
      if (query) {
        const search = await tmdbFetchJson('/search/tv', {
          query,
          language: 'es-ES',
          include_adult: 'false'
        });
        const candidates = Array.isArray(search.results) ? search.results : [];
        const lowered = query.toLowerCase();
        const exact = candidates.find((item) => String(item?.name || '').trim().toLowerCase() === lowered);
        const pick = exact || candidates[0] || null;
        if (pick?.id) tmdbId = String(pick.id);
      }
    } catch {
      // Keep returning null if title search is unavailable.
    }
  }

  if (!tmdbId) {
    console.debug('[mep] TMDB fallback could not resolve title', {
      title: title?.title,
      imdbId: title?.imdbId || '',
      tmdbId: title?.tmdbId || ''
    });
    return null;
  }

  const details = await tmdbFetchJson(`/tv/${encodeURIComponent(tmdbId)}`, { language: 'es-ES' });
  const seasons = [];
  const seasonNumbers = (details.seasons || [])
    .map((season) => Number(season?.season_number))
    .filter((seasonNumber) => Number.isInteger(seasonNumber) && seasonNumber > 0);

  for (const seasonNumber of seasonNumbers) {
    try {
      const seasonData = await tmdbFetchJson(`/tv/${encodeURIComponent(tmdbId)}/season/${seasonNumber}`, { language: 'es-ES' });
      const episodes = (seasonData.episodes || [])
        .map((episode) => ({
          season: seasonNumber,
          episode: Number(episode?.episode_number) || 0,
          title: String(episode?.name || '').trim() || `Episode ${episode?.episode_number}`
        }))
        .filter((episode) => Number.isInteger(episode.episode) && episode.episode > 0)
        .sort((a, b) => a.episode - b.episode);

      if (episodes.length > 0) {
        seasons.push({ seasonNumber, episodes });
      }
    } catch {
      // continue with the next season
    }
  }

  return seasons.length > 0 ? { seasons } : null;
}

function loadLocalCatalog() {
  try { return JSON.parse(localStorage.getItem('mep_static_catalog') || '[]'); } catch { return []; }
}
function saveLocalCatalog(items) { localStorage.setItem('mep_static_catalog', JSON.stringify(items)); }

function cacheSearchResults(results) {
  const current = loadLocalCatalog();
  const merged = dedupe([...current, ...results], { consolidateEquivalent: true });
  saveLocalCatalog(merged);
}

function dedupe(items, options = {}) {
  const { consolidateEquivalent = false } = options;
  const map = new Map();
  for (const item of items) {
    const primaryKey = `${item.type}:${item.imdbId || ''}:${item.tmdbId || ''}:${item.season || ''}:${item.episode || ''}`;
    const fallbackKey = `${item.type}:title:${String(item.title || '').trim().toLowerCase()}:${String(item.year || '')}`;
    const key = consolidateEquivalent ? (item.imdbId ? `${item.type}:imdb:${item.imdbId}` : item.tmdbId ? `${item.type}:tmdb:${item.tmdbId}` : fallbackKey) : primaryKey;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      continue;
    }
    map.set(key, mergeEquivalentTitles(existing, item));
  }
  return [...map.values()];
}

function mergeEquivalentTitles(a, b) {
  const choose = (first, second) => (first !== undefined && first !== null && String(first) !== '' ? first : second);
  return {
    ...a,
    ...b,
    imdbId: choose(a.imdbId, b.imdbId) || choose(b.imdbId, a.imdbId),
    tmdbId: choose(a.tmdbId, b.tmdbId) || choose(b.tmdbId, a.tmdbId),
    title: choose(a.title, b.title),
    year: choose(a.year, b.year),
    description: choose(a.description, b.description),
    posterUrl: choose(a.posterUrl, b.posterUrl),
    playable: a.playable === false && b.playable !== false ? b.playable : (b.playable === false && a.playable !== false ? a.playable : (a.playable === false || b.playable === false ? false : true)),
    metadata: {
      ...(a.metadata || {}),
      ...(b.metadata || {}),
      genres: [...new Set([...(a.metadata?.genres || []), ...(b.metadata?.genres || []), ...(a.categories || []), ...(b.categories || [])])]
    }
  };
}
function mergeAndRankResults(localResults, remoteResults, query) {
  return sortByRelevance(dedupe([...localResults.map((title) => ({ ...title, source: 'local' })), ...remoteResults.map((title) => ({ ...title, source: 'remote' }))], { consolidateEquivalent: true }), query)
    .map((title) => ({ source: title.source || 'remote', title }));
}
function sortByRelevance(items, query) { const q = query.toLowerCase(); return [...items].sort((a, b) => relevanceScore(b, q) - relevanceScore(a, q)); }
function relevanceScore(item, query) { const t = (item.title || '').toLowerCase(); let s = 0; if (t === query) s += 200; if (t.startsWith(query)) s += 120; if (t.includes(query)) s += 80; if (item.type === 'series') s += 8; if (item.posterUrl) s += 5; return s; }

function normalizeSelection(remote) {
  const id = remote.imdbId || remote.tmdbId;
  return { catalogKey: `${remote.type}:${remote.imdbId ? 'imdb' : 'tmdb'}:${id}`, ...remote };
}
function getPlaybackId(entry) {
  return getPlaybackCandidateIds(entry)[0] || '';
}

function getPlaybackCandidateIds(entry) {
  const imdb = String(entry?.imdbId || '').trim();
  const tmdb = String(entry?.tmdbId || '').trim();
  const ids = [];
  const pushUnique = (value) => {
    const id = String(value || '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  };

  if (entry?.type === 'series') {
    if (/^tt\d+$/i.test(imdb)) pushUnique(imdb);
    pushUnique(tmdb);
    pushUnique(imdb);
  } else {
    if (/^tt\d+$/i.test(imdb)) pushUnique(imdb);
    pushUnique(imdb);
    pushUnique(tmdb);
  }
  return ids.filter(Boolean);
}
function buildEmbedUrl(entry) {
  const id = getPlaybackId(entry);
  return entry.type === 'movie'
    ? `https://vaplayer.ru/embed/movie/${encodeURIComponent(id)}`
    : `https://vaplayer.ru/embed/tv/${encodeURIComponent(id)}/${entry.season || 1}/${entry.episode || 1}`;
}
function getPlaybackUrlsForCurrentSelection(primaryUrl) {
  if (!state.selected) return [primaryUrl];
  const ids = getPlaybackCandidateIds(state.selected);
  if (!ids.length) return [primaryUrl];
  const media = state.selected.type === 'movie' ? 'movie' : 'tv';
  const suffix = media === 'movie'
    ? ''
    : `/${state.playback.season || 1}/${state.playback.episode || 1}`;
  const urls = ids.map((id) => `https://vaplayer.ru/embed/${media}/${encodeURIComponent(id)}${suffix}`);
  if (primaryUrl && !urls.includes(primaryUrl)) urls.unshift(primaryUrl);
  return [...new Set(urls)];
}
function clearPlayerFallback() {
  if (state.playerFallbackTimer) {
    clearTimeout(state.playerFallbackTimer);
    state.playerFallbackTimer = null;
  }
  state.playerFallbackUrls = [];
}
function schedulePlayerFallback(urls) {
  clearPlayerFallback();
  const candidates = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (candidates.length < 2) return;
  state.playerFallbackUrls = candidates;
  state.playerFallbackTimer = setTimeout(() => {
    const modal = elements.playerModal;
    const iframe = elements.playerIframe;
    if (!modal || !iframe || modal.hidden) return;
    if (state.playerEventAt > 0 && (Date.now() - state.playerEventAt) <= PLAYER_FALLBACK_DELAY_MS) return;
    const current = String(iframe.src || '');
    const next = candidates.find((url) => String(url) !== current);
    if (next) iframe.src = next;
  }, PLAYER_FALLBACK_DELAY_MS);
}
function isSeriesLike(title) { return title.type === 'series' || title.type === 'episode'; }
function getCurrentEmbedUrl(baseEmbed) {
  if (!isSeriesLike(state.selected)) return baseEmbed;
  const id = getPlaybackId(state.selected);
  return `https://vaplayer.ru/embed/tv/${encodeURIComponent(id)}/${state.playback.season}/${state.playback.episode}`;
}
function getEpisodesForSeason(seasonNumber) { const season = (state.seriesEpisodes?.seasons ?? []).find((entry) => entry.seasonNumber === seasonNumber); return season?.episodes ?? []; }
function positiveInteger(value, fallback) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; }
function syncTabs(type) { elements.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.typeTab === type)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function persistLastSelection() {
  if (!state.selected) return;
  const snapshot = {
    imdbId: state.selected.imdbId || '',
    tmdbId: state.selected.tmdbId || '',
    season: state.playback.season,
    episode: state.playback.episode,
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem('mep_last_selection', JSON.stringify(snapshot));
  persistSyncedWatchSnapshot('lastSelection', snapshot);
}
function getSeriesProgress(title) {
  const id = title.imdbId || title.tmdbId;
  try {
    const local = JSON.parse(localStorage.getItem(`mep_series_progress_${id}`) || '{"watched":{}}');
    const user = getAuthUser();
    const synced = user?.email ? loadSyncedWatchProgress(user.email) : null;
    const remote = synced?.progress?.[id];
    if (!remote) return local;
    return mergeProgressEntry(local, remote) || local;
  } catch {
    return { watched: {} };
  }
}
function loadCachedSeriesEpisodes(imdbId) {
  try {
    const cached = JSON.parse(localStorage.getItem(`mep_series_eps_${imdbId}`) || 'null');
    if (!cached) return null;
    const createdAt = Number(cached.cachedAt || 0);
    const ageMs = Date.now() - createdAt;
    const ttlMs = 1000 * 60 * 60 * 24 * 14;
    if (!createdAt || ageMs > ttlMs) return null;
    return cached.payload || null;
  } catch {
    return null;
  }
}
function cacheSeriesEpisodes(imdbId, payload) {
  try {
    localStorage.setItem(`mep_series_eps_${imdbId}`, JSON.stringify({
      cachedAt: Date.now(),
      payload
    }));
  } catch {
    // ignore storage write issues
  }
}
function isEpisodeWatched(progress, season, episode) {
  const entry = progress?.watched?.[`s${season}e${episode}`];
  if (!entry) return false;
  if (entry === true) return true;
  return Boolean(entry.completedAt);
}

function isEpisodeInProgress(progress, season, episode) {
  const entry = progress?.watched?.[`s${season}e${episode}`];
  return Boolean(entry && entry !== true && entry.startedAt && !entry.completedAt);
}

function getResumeTarget(progress, seriesEpisodes) {
  const seasons = seriesEpisodes?.seasons ?? [];
  if (!seasons.length) return null;
  const lastSeason = positiveInteger(progress?.lastSeason, seasons[0].seasonNumber);
  const lastEpisode = positiveInteger(progress?.lastEpisode, 1);

  const lastKey = `s${lastSeason}e${lastEpisode}`;
  const lastEntry = progress?.watched?.[lastKey];
  const lastCompleted = lastEntry === true ? true : Boolean(lastEntry?.completedAt);

  if (!lastCompleted) {
    return { season: lastSeason, episode: lastEpisode, label: `Reanudar T${lastSeason}E${lastEpisode}` };
  }

  const nextInSeason = (seasons.find((s) => s.seasonNumber === lastSeason)?.episodes ?? []).find((ep) => ep.episode > lastEpisode);
  if (nextInSeason) return { season: lastSeason, episode: nextInSeason.episode, label: `Reanudar T${lastSeason}E${nextInSeason.episode}` };

  const nextSeason = seasons.find((s) => s.seasonNumber > lastSeason && s.episodes.length > 0);
  if (nextSeason) return { season: nextSeason.seasonNumber, episode: nextSeason.episodes[0].episode, label: `Reanudar T${nextSeason.seasonNumber}E${nextSeason.episodes[0].episode}` };

  const firstSeason = seasons[0];
  const firstEpisode = firstSeason?.episodes?.[0]?.episode ?? 1;
  return { season: firstSeason.seasonNumber, episode: firstEpisode, label: `Reanudar T${firstSeason.seasonNumber}E${firstEpisode}` };
}

function getStartTarget(seriesEpisodes) {
  const seasons = seriesEpisodes?.seasons ?? [];
  if (!seasons.length) return null;
  const firstSeason = seasons.find((s) => (s.episodes ?? []).length > 0) || seasons[0];
  const firstEpisode = firstSeason?.episodes?.[0]?.episode ?? 1;
  return { season: firstSeason.seasonNumber, episode: firstEpisode };
}
function applySavedWatchState(title) {
  const currentId = title.imdbId || title.tmdbId;
  if (!currentId || state.hydratedProgressId === currentId) return;
  const progress = getSeriesProgress(title);
  if (isSeriesLike(title)) {
    state.playback.season = positiveInteger(progress.lastSeason, state.playback.season);
    state.playback.episode = positiveInteger(progress.lastEpisode, state.playback.episode);
  }
  state.hydratedProgressId = currentId;
}

window.addEventListener('message', (event) => {
  if (event.data?.type !== 'PLAYER_EVENT') return;
  state.playerEventAt = Date.now();
  const data = event.data.data || {};
  persistProgressFromPlayerEvent(data);
  if (data.player_status !== 'completed' || !isSeriesLike(state.selected)) return;
  const episodes = getEpisodesForSeason(state.playback.season);
  const currentIndex = episodes.findIndex((entry) => entry.episode === state.playback.episode);
  const nextEntry = currentIndex >= 0 ? episodes[currentIndex + 1] : null;
  if (nextEntry) state.playback.episode = nextEntry.episode;
  else {
    state.playback.season += 1;
    const first = getEpisodesForSeason(state.playback.season)[0];
    if (!first) return;
    state.playback.episode = first.episode;
  }
  const modal = elements.playerModal;
  const iframe = elements.playerIframe;
  const nextUrl = getCurrentEmbedUrl(buildEmbedUrl(state.selected));
  if (modal && iframe && !modal.hidden) iframe.src = nextUrl;
  syncRoute();
});

function persistProgressFromPlayerEvent(data) {
  if (!data) return;
  const rawStatus = String(data.player_status || '').trim().toLowerCase();
  const status = rawStatus === 'play' || rawStatus === 'start' || rawStatus === 'started' || rawStatus === 'resume'
    ? 'playing'
    : rawStatus === 'end' || rawStatus === 'ended' || rawStatus === 'complete'
      ? 'completed'
      : rawStatus;
  if (!['playing', 'paused', 'seeked', 'completed'].includes(status)) return;
  const info = data.player_info || {};
  const id = info.imdb || info.tmdb || state.selected?.imdbId || state.selected?.tmdbId;
  if (!id) return;
  const snapshot = { imdbId: info.imdb || state.selected?.imdbId || '', tmdbId: info.tmdb || state.selected?.tmdbId || '', season: Number(info.season || state.playback.season || 1), episode: Number(info.episode || state.playback.episode || 1), progress: Number(data.player_progress || 0) };
  localStorage.setItem('mep_last_watch', JSON.stringify(snapshot));
  const key = `mep_series_progress_${snapshot.imdbId || snapshot.tmdbId}`;
  const existing = JSON.parse(localStorage.getItem(key) || '{"watched":{}}');
  const watched = existing.watched || {};
  const epKey = `s${snapshot.season}e${snapshot.episode}`;
  const prev = watched[epKey];
  const now = Date.now();

  // Backward-compatible upgrade: previously stored `true`.
  const record = (prev && prev !== true)
    ? { startedAt: prev.startedAt || null, completedAt: prev.completedAt || null, lastProgress: Number(prev.lastProgress || 0) }
    : { startedAt: null, completedAt: null, lastProgress: 0 };
  const hadStarted = Boolean(record.startedAt);
  const hadCompleted = Boolean(record.completedAt);

  record.lastProgress = snapshot.progress;
  if (!record.startedAt) record.startedAt = now;
  // Completion is authoritative only when the player emits "completed".
  if (status === 'completed') record.completedAt = record.completedAt || now;
  const justStarted = !hadStarted && Boolean(record.startedAt);
  const justCompleted = !hadCompleted && Boolean(record.completedAt);
  const titleKey = `${snapshot.imdbId || snapshot.tmdbId}:${snapshot.season}x${snapshot.episode}`;
  const startedEmitKey = `${WATCH_PROGRESS_LAST_SYNC_PREFIX}started_emit:${titleKey}`;
  const lastStartedEmitAt = Number(localStorage.getItem(startedEmitKey) || '0');
  const shouldEmitStarted = status === 'playing' && (justStarted || (Date.now() - lastStartedEmitAt) > (30 * 60 * 1000));

  watched[epKey] = record.completedAt ? { ...record } : record;
  const nextProgress = { ...existing, lastSeason: snapshot.season, lastEpisode: snapshot.episode, watched };
  localStorage.setItem(key, JSON.stringify(nextProgress));
  persistSyncedWatchSnapshot('progress', {
    imdbId: snapshot.imdbId,
    tmdbId: snapshot.tmdbId,
    season: snapshot.season,
    episode: snapshot.episode,
    progress: snapshot.progress,
    player_status: status,
    updatedAt: new Date().toISOString()
  });
  if (shouldEmitStarted || justCompleted) {
    if (shouldEmitStarted) localStorage.setItem(startedEmitKey, String(Date.now()));
    void queueWatchProgressSync({
      imdbId: snapshot.imdbId,
      tmdbId: snapshot.tmdbId,
      season: snapshot.season,
      episode: snapshot.episode,
      progress: snapshot.progress,
      player_status: justCompleted ? 'completed' : 'playing',
      event_type: justCompleted ? 'completed' : 'started',
      started_at: record.startedAt ? new Date(record.startedAt).toISOString() : '',
      completed_at: record.completedAt ? new Date(record.completedAt).toISOString() : ''
    });
  }
}

function requestNativeFullscreen(element) {
  if (!element || document.fullscreenElement) return;
  const fn = element.requestFullscreen || element.webkitRequestFullscreen || element.msRequestFullscreen;
  if (typeof fn === 'function') fn.call(element).catch?.(() => {});
}

function bindPlayerModalEvents() {
  const modal = elements.playerModal;
  if (!modal) return;
  modal.querySelector('[data-close-player]')?.addEventListener('click', closePlayerModal);
}

function renderPlayerControls() {
  if (!elements.playerControls) return;
  if (isSeriesLike(state.selected)) {
    elements.playerControls.innerHTML = `
      <div class="player-nav-row">
        <button class="player-nav" data-player-action="back">Volver a la serie</button>
        <button class="player-nav" data-player-action="prev">Capítulo anterior</button>
        <button class="player-nav" data-player-action="next">Siguiente capítulo</button>
      </div>
    `;
  } else {
    elements.playerControls.innerHTML = `<button class="player-nav" data-player-action="close">Cerrar</button>`;
  }
  elements.playerControls.querySelectorAll('[data-player-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.playerAction;
      if (action === 'close' || action === 'back') {
        closePlayerModal();
        return;
      }
      if (action === 'prev') {
        jumpEpisode(-1, buildEmbedUrl(state.selected));
        return;
      }
      if (action === 'next') {
        jumpEpisode(1, buildEmbedUrl(state.selected));
      }
    });
  });
}

function syncRoute() {
  if (suppressRouteSync) return;
  const params = new URLSearchParams();
  const q = elements.search.value.trim();
  const type = elements.typeFilter.value;
  if (q) params.set('q', q);
  if (type && type !== 'all') params.set('type', type);

  let routePath = '/browse';
  const modal = elements.playerModal;
  if (state.selected) {
    const id = state.selected.imdbId || state.selected.tmdbId;
    const media = state.selected.type === 'movie' ? 'movie' : 'series';
    if (id) {
      if (modal && !modal.hidden) {
        if (media === 'movie') {
          routePath = `/view/movie/${encodeURIComponent(id)}`;
        } else {
          routePath = `/view/series/${encodeURIComponent(id)}/${state.playback.season || 1}/${state.playback.episode || 1}`;
        }
      } else {
        routePath = `/title/${encodeURIComponent(media)}/${encodeURIComponent(id)}`;
      }
    }
  }

  const nextHash = `#${routePath}${params.toString() ? `?${params.toString()}` : ''}`;
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }
}

async function handleRouteChange() {
  suppressRouteSync = true;
  try {
    const route = parseHashRoute();
    const params = route.params;
    const q = params.get('q') || '';
    const type = params.get('type') || 'all';
    const id = route.id || '';
    const media = route.media || '';
    const season = positiveInteger(route.season, 1);
    const episode = positiveInteger(route.episode, 1);
    const shouldOpenPlayer = route.mode === 'watch';

    if (isAdminUser()) {
      state.selected = null;
      state.seriesEpisodes = null;
      closePlayerModal();
      renderCatalog();
      return;
    }

    elements.search.value = q;
    elements.typeFilter.value = ['all', 'movie', 'series'].includes(type) ? type : 'all';
    syncTabs(elements.typeFilter.value);

    if (id) {
      const currentId = state.selected ? (state.selected.imdbId || state.selected.tmdbId) : '';
      const isSameSelected = currentId && currentId === id;
      const modalNow = elements.playerModal;
      const iframeNow = elements.playerIframe;

      if (route.mode === 'watch' && isSameSelected && modalNow && !modalNow.hidden && iframeNow) {
        state.playback.season = season;
        state.playback.episode = episode;
        const targetUrl = getCurrentEmbedUrl(buildEmbedUrl(state.selected));
        if (iframeNow.src !== targetUrl) {
          iframeNow.src = targetUrl;
        }
        return;
      }

      const fromLocal = loadLocalCatalog().find((entry) => entry.imdbId === id || entry.tmdbId === id);
      const previous = state.selected;
      const previousId = String(previous?.imdbId || previous?.tmdbId || '').trim();
      state.selected = fromLocal || normalizeSelection({
        imdbId: id.startsWith('tt') ? id : '',
        tmdbId: id.startsWith('tt') ? '' : id,
        title: fromLocal?.title || previous?.title || id,
        year: fromLocal?.year || null,
        type: media === 'movie' ? 'movie' : 'series',
        posterUrl: fromLocal?.posterUrl || previous?.posterUrl || '',
        description: fromLocal?.description || (previousId === id ? previous?.description : '') || 'Cargado desde ruta'
      });
      state.playback.season = season;
      state.playback.episode = episode;
      state.seriesEpisodes = null;
      state.seriesEpisodesLoading = isAuthenticated() && isSeriesLike(state.selected);
      renderDetail({ skipHydratePlayback: shouldOpenPlayer });
      if (shouldOpenPlayer) {
        // iOS Safari can be flaky about repainting fixed overlays immediately;
        // deferring a tick makes the modal+hash transition more reliable.
        const target = getCurrentEmbedUrl(buildEmbedUrl(state.selected));
        setTimeout(() => openPlayerModal(target), 0);
      }
      if (isAuthenticated() && isSeriesLike(state.selected)) {
        await loadSeriesEpisodes();
        renderDetail({ skipHydratePlayback: shouldOpenPlayer });
      }
      renderCatalog();
      if (isAuthenticated() && q.length >= 3) searchRemoteCatalog(q);
      if (!shouldOpenPlayer) closePlayerModal();
    } else {
      renderCatalog();
      if (isAuthenticated() && q.length >= 3) await searchRemoteCatalog(q);
      state.selected = null;
      state.seriesEpisodes = null;
      renderDetail();
      closePlayerModal();
    }
  } finally {
    suppressRouteSync = false;
  }
}

function parseHashRoute() {
  const hash = window.location.hash || '';
  if (hash.startsWith('#/')) {
    const noHash = hash.slice(1);
    const [pathPart, queryPart = ''] = noHash.split('?');
    const parts = pathPart.split('/').filter(Boolean);
    const params = new URLSearchParams(queryPart);

    if (parts[0] === 'view') {
      return {
        mode: 'watch',
        media: decodeURIComponent(parts[1] || ''),
        id: decodeURIComponent(parts[2] || ''),
        season: parts[3] || '1',
        episode: parts[4] || '1',
        params
      };
    }

    if (parts[0] === 'title') {
      return {
        mode: 'title',
        media: decodeURIComponent(parts[1] || ''),
        id: decodeURIComponent(parts[2] || ''),
        season: '1',
        episode: '1',
        params
      };
    }

    return { mode: 'browse', media: '', id: '', season: '1', episode: '1', params };
  }

  // Backward compatibility with legacy query-based routes.
  const params = new URLSearchParams(window.location.search);
  return {
    mode: params.get('player') === '1' ? 'watch' : (params.get('id') ? 'title' : 'browse'),
    media: params.get('media') || '',
    id: params.get('id') || '',
    season: params.get('season') || '1',
    episode: params.get('episode') || '1',
    params
  };
}

function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
function escapeAttribute(value) { return escapeHtml(value); }
