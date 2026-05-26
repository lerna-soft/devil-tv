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
  activeProviderId: '',
  searchIntentId: 0,
  lastCountLabel: '0 títulos',
  searchingTerm: '',
  localCatalogCache: null,
  catalogVisibleCount: 72,
  lastCatalogRenderKey: '',
  genreFilterCacheKey: '',
  genreFilterOptionsHtml: '',
  filteredCatalogCacheKey: '',
  filteredCatalogCache: null,
  catalogHydrationRenderTimer: null,
  catalogHydration: {
    active: false,
    loaded: 0,
    total: 0,
    phase: ''
  }
};
let suppressRouteSync = false;
let routeChangeToken = 0;
let episodeIndexPromise = null;
let episodeManifestPromise = null;
let watchProgressHeartbeatStarted = false;
const episodeTextPromises = new Map();
const homeCarouselLastDragAt = new WeakMap();
let detailEpisodePointerHandledAt = 0;

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
// Antes persistíamos el provider seleccionado en `mep_provider_v1`. Eso provocaba
// que tocar otro servidor una vez dejara ese servidor pegado para siempre — la
// próxima apertura del player arrancaba con Servidor 4 (o el que fuera) en vez
// del 1 sin ads. Ahora el provider activo vive solo en memoria; cada apertura
// fresca del modal vuelve a Servidor 1, y el cambio sólo dura mientras el modal
// esté abierto (incluye jumpEpisode, que reabre con el modal aún visible).
// `allow-fullscreen` es REQUERIDO en el sandbox para que la Fullscreen API
// funcione tanto desde el parent (nuestro botón "Pantalla completa") como
// desde el código del propio iframe. Sin ese token, requestFullscreen sobre
// el iframe rechaza con "Permissions policy violation: fullscreen is not
// allowed in this document".
const DEFAULT_PLAYER_SANDBOX = 'allow-scripts allow-same-origin allow-presentation allow-fullscreen';
const SUBS_WORKER_BASE = 'https://devil-tv-recovery.hglerna.workers.dev/subs';

// Token mutable que invalida renders en vuelo cuando renderCatalog se vuelve
// a llamar mid-stream (cambio de tab, click de un item, etc.). Sin esto, dos
// renders simultáneos chocan en elements.items.innerHTML. Declarado aquí (no
// junto a renderHomeCatalog) porque handleRouteChange() corre top-level ~línea
// 1383, antes de que la ejecución alcanzara la declaración original, causando
// TDZ: "Cannot access 'homeRenderToken' before initialization".
let homeRenderToken = 0;

// Mismo motivo TDZ: scheduleAuthenticatedStartupWork() corre top-level y
// llama installVisibilityRehydrate(), que lee estas variables. Si se
// declaran junto a la función (más abajo), no están inicializadas al
// momento del call → ReferenceError.
let watchProgressLastHydrate = Date.now();
let visibilityRehydrateBound = false;

// Logger estructurado para debug. Pensado para debugging post-mortem: si el
// user reporta "no apareció X", se le puede pedir copy/paste del console y
// reconstruir el flujo. Scopes y su nivel:
//   boot/catalog/render → debug (collapsable, no spammean en prod)
//   sync/queue          → info  (importantes para Continuar Viendo)
//   player              → info
//   error               → error
//   warn                → warn
// `data` se imprime con console.table cuando es un array de objetos homogéneos
// o un objeto con valores primitivos; sino con el log normal.
const DTV_SCOPE_LEVEL = {
  boot: 'debug', catalog: 'debug', render: 'debug',
  sync: 'info', queue: 'info', player: 'info',
  warn: 'warn', error: 'error'
};

function dtvIsTabular(data) {
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') return true;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const values = Object.values(data);
    if (values.length === 0) return false;
    return values.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
  }
  return false;
}

// Toast helper centralizado. Wrappea SweetAlert si está cargado; en su
// ausencia es no-op para no romper el flujo (la app ya tiene fallbacks
// donde el mensaje es crítico). Sustituye al patrón Swal.fire(...) duplicado
// en varios sitios y permite cambiar el theme/posición desde un solo lugar.
function showToast({ icon = 'info', title, timer = 3500, position = 'top-end' } = {}) {
  if (!title || typeof Swal === 'undefined') return;
  try {
    Swal.fire({
      toast: true,
      position,
      icon,
      title,
      showConfirmButton: false,
      timer,
      timerProgressBar: true
    });
  } catch {}
}

function dtvLog(scope, msg, data) {
  try {
    const t = new Date().toISOString().slice(11, 23);
    const prefix = `[devil-tv ${t}][${scope}]`;
    const level = DTV_SCOPE_LEVEL[scope] || 'log';
    const fn = console[level] || console.log;
    if (data === undefined) {
      fn.call(console, `${prefix} ${msg}`);
    } else if (dtvIsTabular(data)) {
      fn.call(console, `${prefix} ${msg}`);
      console.table(data);
    } else {
      fn.call(console, `${prefix} ${msg}`, data);
    }
  } catch {
    // sin-op: si console no está disponible no rompemos el flujo.
  }
}

// Snapshot completo del estado de Continuar Viendo / sync. El user lo invoca
// desde la DevTools console (`devilTvDiag()` o `window.devilTvDiag()`) y nos
// permite ver de un vistazo si el problema está en (a) auth, (b) catálogo
// local, (c) sync remoto, (d) merge de continueIds. Pensado para diagnosticar
// el bug "abrí Ghost en sesión A pero no aparece en sesión B".
function devilTvDiag() {
  try {
    const user = (typeof getAuthUser === 'function' ? getAuthUser() : null) || {};
    const catalog = (typeof loadLocalCatalog === 'function' ? loadLocalCatalog() : []) || [];
    const synced = user.email && typeof loadSyncedWatchProgress === 'function'
      ? (loadSyncedWatchProgress(user.email) || null)
      : null;
    const insights = typeof buildWatchInsights === 'function' ? buildWatchInsights() : null;
    const lastWatch = (() => {
      try { return JSON.parse(localStorage.getItem('mep_last_watch') || 'null'); } catch { return null; }
    })();
    const seriesProgressKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || '';
      if (k.startsWith('mep_series_progress_')) seriesProgressKeys.push(k.replace('mep_series_progress_', ''));
    }
    const continueIds = insights?.continueIds ? [...insights.continueIds] : [];
    const completedIds = insights?.completedIds ? [...insights.completedIds] : [];
    const byId = {};
    for (const t of catalog) {
      const id = String(t?.tmdbId || t?.imdbId || '').trim();
      if (id) byId[id] = t;
    }
    const continueResolved = continueIds.map((id) => {
      const t = byId[id];
      return {
        id,
        inCatalog: Boolean(t),
        title: t?.title || '',
        type: t?.type || '',
        hasPoster: Boolean(t?.posterUrl || t?.metadata?.posterUrl),
        recentAt: insights?.recentAt?.[id] ? new Date(insights.recentAt[id]).toISOString() : ''
      };
    });
    console.group('%c[devil-tv] diag snapshot', 'color:#e44; font-weight:bold');
    console.info('Auth', { email: user.email || '(none)', name: user.name || '' });
    console.info('Catalog local', { items: catalog.length });
    console.info('Last watch (local)', lastWatch);
    console.info('Local mep_series_progress_* keys', seriesProgressKeys.length);
    console.group('Synced (remote merged)');
    if (synced) {
      console.info('updatedAt', synced.updatedAt);
      console.info('progress entries', Object.keys(synced.progress || {}).length);
      console.info('history events', (synced.history || []).length);
      console.info('lastWatch (remote)', synced.lastWatch || null);
      const progressTable = Object.entries(synced.progress || {}).map(([id, p]) => ({
        id,
        imdbId: p?.imdbId || '',
        tmdbId: p?.tmdbId || '',
        s: p?.lastSeason ?? '',
        e: p?.lastEpisode ?? '',
        progress: Number(p?.lastProgress ?? p?.progress ?? 0).toFixed(1),
        updatedAt: p?.updatedAt || ''
      }));
      if (progressTable.length) console.table(progressTable);
    } else {
      console.warn('No synced data — user not authed or remote fetch never ran. ' +
        'Llama window.devilTvForceSync() para forzar el hydrate.');
    }
    console.groupEnd();
    console.group(`Continuar Viendo · ${continueResolved.length} ids resueltos`);
    if (continueResolved.length === 0) {
      console.warn('continueIds vacío. Si esperabas verlo: verifica auth, espera hydrate (~3s) o llama devilTvForceSync().');
    } else {
      console.table(continueResolved);
      const orphans = continueResolved.filter((r) => !r.inCatalog);
      if (orphans.length) console.warn(`${orphans.length} ids con progress pero NO están en el catálogo local`);
      const noPoster = continueResolved.filter((r) => r.inCatalog && !r.hasPoster);
      if (noPoster.length) console.warn(`${noPoster.length} ids en catálogo sin poster (se filtran fuera del home)`);
    }
    console.groupEnd();
    console.info('completed', completedIds.length);
    console.groupEnd();
    return { user, synced, continueIds, completedIds, byIdCount: Object.keys(byId).length };
  } catch (err) {
    console.error('[devil-tv] diag failed', err);
    return null;
  }
}

async function devilTvForceSync() {
  if (typeof hydrateWatchProgressForCurrentUser !== 'function') {
    console.warn('[devil-tv] hydrateWatchProgressForCurrentUser no disponible');
    return;
  }
  console.info('[devil-tv] forcing hydrateWatchProgressForCurrentUser…');
  await hydrateWatchProgressForCurrentUser();
  console.info('[devil-tv] force sync done. Re-render solicitado.');
  return devilTvDiag();
}

if (typeof window !== 'undefined') {
  window.devilTvDiag = devilTvDiag;
  window.devilTvForceSync = devilTvForceSync;
}

// Devuelve la URL del worker /subs si el entry tiene imdbId válido,
// o '' si no se puede pedir subs (sin imdb el upstream falla).
function buildSubsUrl(entry, season, episode) {
  const imdb = String(entry?.imdbId || '').trim();
  if (!/^tt\d+$/.test(imdb)) return '';
  const params = new URLSearchParams({ imdb, lang: 'es' });
  if (season && episode && /^\d+$/.test(String(season)) && /^\d+$/.test(String(episode))) {
    params.set('season', String(season));
    params.set('episode', String(episode));
  }
  return `${SUBS_WORKER_BASE}?${params.toString()}`;
}

// Servidor 1 (vaplayer) es el DEFAULT y no negociable (sin ads).
// Los demás son alternativas bajo demanda, escogidos priorizando: docs
// verificables, anime support, API de subs configurables.
//
// `subsUrl(entry, s, e)` opcional: devuelve la URL del worker /subs si
// este provider acepta sub_file/sub_url. Se usa para pre-warm de la cache
// del CF edge antes de abrir el iframe (evita que el player espere por
// OpenSubtitles upstream).
const PLAYBACK_PROVIDERS = [
  {
    id: 'vaplayer',
    label: 'Servidor 1',
    note: 'sin ads',
    sandbox: DEFAULT_PLAYER_SANDBOX,
    movie: (id) => `https://vaplayer.ru/embed/movie/${encodeURIComponent(id)}`,
    tv: (id, s, e) => `https://vaplayer.ru/embed/tv/${encodeURIComponent(id)}/${s}/${e}`
  },
  {
    id: 'vidlink',
    label: 'Servidor 2',
    note: 'anime/orig · ads · subs ES',
    sandbox: null,
    subsUrl: (entry, s, e) => buildSubsUrl(entry, s, e),
    // vidlink TV requiere tmdbId (con imdbId responde HTTP 500).
    movie: (id, entry) => {
      const base = `https://vidlink.pro/movie/${encodeURIComponent(id)}`;
      const subUrl = buildSubsUrl(entry);
      return subUrl
        ? `${base}?sub_file=${encodeURIComponent(subUrl)}&sub_label=${encodeURIComponent('Español')}`
        : base;
    },
    tv: (id, s, e, entry) => {
      const tvId = String(entry?.tmdbId || id);
      const base = `https://vidlink.pro/tv/${encodeURIComponent(tvId)}/${s}/${e}`;
      const subUrl = buildSubsUrl(entry, s, e);
      return subUrl
        ? `${base}?sub_file=${encodeURIComponent(subUrl)}&sub_label=${encodeURIComponent('Español')}`
        : base;
    }
  },
  {
    id: 'vidsrc-cc',
    label: 'Servidor 3',
    note: 'multi-audio · ads',
    sandbox: null,
    movie: (id) => `https://vidsrc.cc/v2/embed/movie/${encodeURIComponent(id)}`,
    tv: (id, s, e) => `https://vidsrc.cc/v2/embed/tv/${encodeURIComponent(id)}/${s}/${e}`
  },
  {
    id: '111movies',
    label: 'Servidor 4',
    note: 'alternativo · ads',
    sandbox: null,
    movie: (id) => `https://111movies.com/movie/${encodeURIComponent(id)}`,
    tv: (id, s, e) => `https://111movies.com/tv/${encodeURIComponent(id)}/${s}/${e}`
  },
  {
    id: 'embedmaster',
    label: 'Servidor 5',
    note: 'subs ES garantizados · ads',
    sandbox: null,
    subsUrl: (entry, s, e) => buildSubsUrl(entry, s, e),
    // EmbedMaster acepta arrays sub_url[]/sub_label[] (sintaxis PHP).
    // Redirige a embdmstrplayer.com con token por request — el browser
    // sigue el 302 transparente dentro del iframe.
    movie: (id, entry) => {
      const base = `https://embedmaster.link/movie/${encodeURIComponent(id)}`;
      const subUrl = buildSubsUrl(entry);
      return subUrl
        ? `${base}?sub_url%5B%5D=${encodeURIComponent(subUrl)}&sub_label%5B%5D=${encodeURIComponent('Español')}`
        : base;
    },
    tv: (id, s, e, entry) => {
      const base = `https://embedmaster.link/tv/${encodeURIComponent(id)}/${s}/${e}`;
      const subUrl = buildSubsUrl(entry, s, e);
      return subUrl
        ? `${base}?sub_url%5B%5D=${encodeURIComponent(subUrl)}&sub_label%5B%5D=${encodeURIComponent('Español')}`
        : base;
    }
  }
];

const SECTION_CACHE_STORAGE_KEY = 'mep_section_cache_v1';

const WATCH_PROGRESS_SYNC_LABEL = 'watch-progress-sync';
const USER_REPORT_LABEL = 'user-report';
const USER_REPORT_PLATFORM_LABEL = 'user-report-platform';
const USER_REPORT_TITLE_LABEL = 'user-report-title';
const USER_REPORT_EPISODE_LABEL = 'user-report-episode';
const TITLE_PREFS_STORAGE_PREFIX = 'mep_title_prefs_';
const EVAL_STORAGE_KEY = 'mep_evaluations_v1';
const TMDB_READ_TOKEN_SEED = 'mep_tmdb_token_key_v1';
const TMDB_READ_TOKEN_CIPHER = 'CBw6NxYqBwsQHSUiMBQWWisQFU8fCBw6NxA6NQsQHSUCPzo0EiouFR1+OiMaEhkoVTsIJRgmMSw3MTE/MzsDIwg9bSVZKggWRCICLB0WBlAQBR94WygkPEciICcmOysiVSA2X1c2GydCJAs+bi0ELVQWHjZePwMSEystPERoOScbETMgHDsIPgcxDyg2JiI0JzhIJBY5MToHBlEdGAwSLFgIEi8RPDFdCwYdCRw3Jyg7OCwhVzQHIR8YCE9EJA8fJxI8SiU4GSUbXCI9XiEobwxEGVAZLBcHAFppBAAsMDkRBFxACB1mOBEkGTECICc=';
const TMDB_META_CACHE_KEY = 'mep_tmdb_meta_cache_v1';
const TMDB_ALERT_LABEL = 'tmdb-token-alert';
const TMDB_ALERT_DEDUPE_PREFIX = 'mep_tmdb_alert_once_';
const SEED_SYNC_LABEL = 'catalog-seed-sync';
const SEED_SYNC_DEDUPE_PREFIX = 'mep_seed_sync_once_';
const SEED_METADATA_REPAIR_DEDUPE_PREFIX = 'mep_seed_metadata_repair_once_';
const SEED_CATALOG_KEYS_STORAGE = 'mep_seed_catalog_keys_v1';
const SEED_BOOTSTRAP_VERSION_STORAGE = 'mep_seed_bootstrap_version';
const SEED_VERSION_HINT_PATH = './assets/catalog.version.json';
const SEED_BOOTSTRAP_PATH = './assets/catalog.bootstrap.json';
const SEED_CHUNKS_INDEX_PATH = './assets/catalog.chunks/index.json';
const SEED_SYNC_WINDOW_MS = 12 * 60 * 60 * 1000;
const WATCH_PROGRESS_HEARTBEAT_MS = 30 * 1000;
const WATCH_PROGRESS_HEARTBEAT_LOCK_KEY = 'mep_watch_progress_queue_heartbeat_lock_v1';
const WATCH_PROGRESS_HEARTBEAT_DISPATCH_KEY = 'mep_watch_progress_queue_heartbeat_last_dispatch_v1';
const WATCH_PROGRESS_HEARTBEAT_DISPATCH_WINDOW_MS = 2 * 60 * 1000;
const EPISODE_MANIFEST_CACHE_KEY = 'mep_episode_manifest_v1';
const EPISODE_MANIFEST_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const PLAYER_FALLBACK_DELAY_MS = 6500;
const CATALOG_PAGE_SIZE = 72;
const RELEASE_NOTES_CACHE_KEY = 'mep_release_notes_cache_v2';
const RELEASE_NOTES_CACHE_TTL_MS = 1000 * 60 * 15;
const RELEASES_REPO_OWNER = 'lerna-admin';
const RELEASES_REPO_NAME = 'media-evaluation-platform-static';
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
  searchHelpBtn: document.querySelector('#searchHelpBtn'),
  playerModal: document.querySelector('#playerModal'),
  playerIframe: document.querySelector('#player'),
  playerControls: document.querySelector('#playerControls'),
  playerServerTabs: document.querySelector('#playerServerTabs'),
  authGate: document.querySelector('#authGate'),
  authFormLogin: document.querySelector('#authFormLogin'),
  authEmailLogin: document.querySelector('#authEmailLogin'),
  authPasswordLogin: document.querySelector('#authPasswordLogin'),
  authErrorLogin: document.querySelector('#authErrorLogin'),
  authSubmitLogin: document.querySelector('#authSubmitLogin'),
  authToggleLogin: document.querySelector('#authToggleLogin'),
  authForgotLogin: document.querySelector('#authForgotLogin'),
  authFormRegister: document.querySelector('#authFormRegister'),
  authNameRegister: document.querySelector('#authNameRegister'),
  authEmailRegister: document.querySelector('#authEmailRegister'),
  authPasswordRegister: document.querySelector('#authPasswordRegister'),
  authPasswordConfirmRegister: document.querySelector('#authPasswordConfirmRegister'),
  authErrorRegister: document.querySelector('#authErrorRegister'),
  authSubmitRegister: document.querySelector('#authSubmitRegister'),
  authToggleRegister: document.querySelector('#authToggleRegister'),
  loginCard: document.querySelector('#loginCard'),
  registerCard: document.querySelector('#registerCard'),
  floatingReportBtn: document.querySelector('#floatingReportBtn'),
  releaseNotesBtn: document.querySelector('#releaseNotesBtn'),
  releaseVersionText: document.querySelector('#releaseVersionText')
};

let authMode = 'login';

function clearSelection({ closePlayer = false } = {}) {
  state.selected = null;
  state.seriesEpisodes = null;
  state.seriesEpisodesLoading = false;
  state.hydratedProgressId = '';
  if (closePlayer) closePlayerModal();
}

function resetCatalogViewport() {
  state.catalogVisibleCount = CATALOG_PAGE_SIZE;
}

function isCompactViewport() {
  return window.matchMedia('(max-width: 720px)').matches;
}

function prepareManualRouteTransition() {
  routeChangeToken += 1;
  suppressRouteSync = false;
}

function classifyReleaseType(message) {
  const normalized = String(message || '').trim().toLowerCase();
  if (!normalized) return 'minor';
  if (/breaking|major|migration|overhaul|redesign|rewrite/.test(normalized)) return 'major';
  if (/fix|bug|avoid|ignore|hide|reduce|cancel|stale|prioritize|dedupe|repair|correct/.test(normalized)) return 'fix';
  return 'minor';
}

function getReleaseTypeLabel(type) {
  if (type === 'major') return 'Major';
  if (type === 'fix') return 'Fix';
  return 'Minor';
}

function localizeReleaseSummary(message) {
  const text = String(message || '').trim();
  if (!text) return 'Actualización del producto.';
  if (/^prioritize manual title switches over stale route sync$/i.test(text)) return 'Se priorizó el cambio manual entre títulos para evitar cierres por sincronizaciones viejas.';
  if (/^ignore stale route changes when switching titles$/i.test(text)) return 'Se bloquearon cambios de ruta obsoletos al cambiar rápido entre títulos.';
  if (/^hide partial results during active search$/i.test(text)) return 'La búsqueda espera el listado final antes de mostrar resultados.';
  if (/^cancel pending search work on selection$/i.test(text)) return 'Al abrir un título se cancelan búsquedas pendientes que podían desestabilizar la vista.';
  if (/^reduce search rerender churn$/i.test(text)) return 'Se redujeron rerenders intermedios para que la búsqueda no haga saltar la pantalla.';
  if (/^unify title resolution across search results$/i.test(text)) return 'Todos los resultados resuelven el título desde un flujo único en memoria.';
  if (/^avoid double-click handling on remote results$/i.test(text)) return 'Se evitó el doble manejo de clics que podía reabrir o cerrar resultados.';
  if (/^drain watch-progress queue$/i.test(text)) return 'Se estabilizó la cola de sincronización del progreso de visualización.';
  const catalogSeedMatch = text.match(/^sync catalog seed from issue #(\d+)$/i);
  if (catalogSeedMatch) return `Se sincronizó el catálogo base con el ajuste registrado en el issue #${catalogSeedMatch[1]}.`;
  const watchProgressMatch = text.match(/^sync watch progress from issue #(\d+)$/i);
  if (watchProgressMatch) return `Se sincronizó progreso de visualización desde el issue #${watchProgressMatch[1]}.`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatReleaseDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  return date.toLocaleDateString('es-CO', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function formatDateShort(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('es-CO', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function normalizeReleaseEntry(entry) {
  const version = String(entry?.version || entry?.tag || entry?.sha || '').trim();
  const message = String(entry?.message || entry?.title || '').trim();
  const notes = String(entry?.notes || '').trim();
  const type = classifyReleaseType(message || notes);
  const displayVersion = /^v?\d+\.\d+\.\d+([.-][0-9A-Za-z]+)?$/i.test(version) ? version : (version.slice(0, 7) || 'local');
  return {
    version,
    shortVersion: displayVersion,
    message,
    notes,
    type,
    typeLabel: getReleaseTypeLabel(type),
    summary: localizeReleaseSummary(message || notes),
    date: String(entry?.date || '').trim(),
    url: String(entry?.url || '').trim()
  };
}

function loadReleaseNotesCache() {
  try {
    const raw = localStorage.getItem(RELEASE_NOTES_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.entries)) return null;
    const fetchedAt = Number(parsed?.fetchedAt || 0);
    if (!fetchedAt || (Date.now() - fetchedAt) > RELEASE_NOTES_CACHE_TTL_MS) return null;
    return parsed.entries.map(normalizeReleaseEntry).filter((entry) => entry.version);
  } catch {
    return null;
  }
}

function saveReleaseNotesCache(entries) {
  try {
    localStorage.setItem(RELEASE_NOTES_CACHE_KEY, JSON.stringify({
      fetchedAt: Date.now(),
      entries
    }));
  } catch {}
}

async function fetchReleaseNotes(force = false) {
  if (!force) {
    const cached = loadReleaseNotesCache();
    if (cached?.length) return cached;
  }
  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(RELEASES_REPO_OWNER)}/${encodeURIComponent(RELEASES_REPO_NAME)}`;
  const releaseResponse = await fetch(`${baseUrl}/releases?per_page=20`, {
    headers: { accept: 'application/vnd.github+json' },
    cache: 'no-store'
  }).catch(() => null);
  if (releaseResponse?.ok) {
    const releases = await releaseResponse.json().catch(() => []);
    const releaseEntries = releases.map((release) => normalizeReleaseEntry({
      version: String(release?.tag_name || '').trim(),
      title: String(release?.name || release?.tag_name || '').trim(),
      notes: String(release?.body || '').trim(),
      date: String(release?.published_at || release?.created_at || '').trim(),
      url: String(release?.html_url || '').trim()
    })).filter((entry) => entry.version);
    if (releaseEntries.length) {
      saveReleaseNotesCache(releaseEntries);
      return releaseEntries;
    }
  }
  const commitResponse = await fetch(`${baseUrl}/commits?per_page=20`, {
    headers: { accept: 'application/vnd.github+json' },
    cache: 'no-store'
  }).catch(() => null);
  if (!commitResponse?.ok) {
    const cached = loadReleaseNotesCache();
    if (cached?.length) return cached;
    return [];
  }
  const commits = await commitResponse.json().catch(() => []);
  const entries = commits.map((commit) => normalizeReleaseEntry({
    version: String(commit?.sha || '').trim(),
    message: String(commit?.commit?.message || '').split('\n')[0].trim(),
    date: String(commit?.commit?.author?.date || '').trim(),
    url: String(commit?.html_url || '').trim()
  })).filter((entry) => entry.version && entry.message);
  if (entries.length) saveReleaseNotesCache(entries);
  return entries;
}

function renderReleaseBadge(entries = []) {
  if (!elements.releaseVersionText) return;
  const current = Array.isArray(entries) && entries.length ? entries[0] : null;
  if (!current) {
    const seedVersion = Number(localStorage.getItem('mep_seed_version') || '0');
    elements.releaseVersionText.textContent = seedVersion ? `vseed-${seedVersion}` : 'Versiones';
    return;
  }
  elements.releaseVersionText.textContent = current.shortVersion;
}

function buildReleaseNotesHtml(entries = []) {
  if (!entries.length) {
    return `<div class="release-notes-modal"><p class="release-empty-copy">No fue posible cargar el historial de versiones en este momento.</p></div>`;
  }
  const current = entries[0];
  const previous = entries.slice(1);
  const renderNotes = (entry) => {
    const notes = String(entry?.notes || '').trim();
    if (!notes) return '';
    return `<p>${escapeHtml(notes).replaceAll('\n', '<br>')}</p>`;
  };
  const jumps = previous.slice(0, 8).map((entry) => (
    `<button type="button" class="release-jump" data-release-target="release-${escapeAttribute(entry.shortVersion)}">${escapeHtml(entry.shortVersion)}</button>`
  )).join('');
  const previousHtml = previous.map((entry) => (
    `<article class="release-entry" id="release-${escapeAttribute(entry.shortVersion)}">
      <div class="release-entry-header">
        <span class="release-type release-type-${escapeAttribute(entry.type)}">${escapeHtml(entry.typeLabel)}</span>
        <span class="release-version">${escapeHtml(entry.shortVersion)}</span>
        <span class="release-date">${escapeHtml(formatReleaseDate(entry.date))}</span>
      </div>
      <p>${escapeHtml(entry.summary)}</p>
      ${renderNotes(entry)}
      <div class="release-links">
        <a href="${escapeAttribute(entry.url)}" target="_blank" rel="noreferrer">Ver commit</a>
        <span>${escapeHtml(entry.message)}</span>
      </div>
    </article>`
  )).join('');
  return `<div class="release-notes-modal">
    <section class="release-current">
      <div class="release-current-header">
        <span class="release-kicker">Versión actual</span>
        <span class="release-type release-type-${escapeAttribute(current.type)}">${escapeHtml(current.typeLabel)}</span>
        <span class="release-version">${escapeHtml(current.shortVersion)}</span>
        <span class="release-date">${escapeHtml(formatReleaseDate(current.date))}</span>
      </div>
      <p>${escapeHtml(current.summary)}</p>
      ${renderNotes(current)}
      <div class="release-links">
        <a href="${escapeAttribute(current.url)}" target="_blank" rel="noreferrer">Ver commit actual</a>
        <span>${escapeHtml(current.message)}</span>
      </div>
    </section>
    ${jumps ? `<div class="release-nav">${jumps}</div>` : ''}
    <section class="release-list">${previousHtml}</section>
  </div>`;
}

async function openReleaseNotes() {
  if (typeof Swal === 'undefined') return;
  const loadingText = elements.releaseVersionText?.textContent || 'Cargando...';
  void Swal.fire({
    title: 'Historial de versiones',
    html: `<div class="release-notes-modal"><p class="release-empty-copy">Cargando versiones publicadas...</p></div>`,
    width: 860,
    customClass: { popup: 'release-notes-popup' },
    showCloseButton: true,
    showConfirmButton: false,
    didOpen: async (popup) => {
      const htmlContainer = popup.querySelector('.swal2-html-container');
      const entries = await fetchReleaseNotes().catch(() => []);
      renderReleaseBadge(entries);
      if (!htmlContainer) return;
      htmlContainer.innerHTML = buildReleaseNotesHtml(entries);
      htmlContainer.querySelectorAll('[data-release-target]').forEach((button) => button.addEventListener('click', () => {
        const targetId = String(button.getAttribute('data-release-target') || '').trim();
        const target = htmlContainer.querySelector(`#${CSS.escape(targetId)}`);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }));
    }
  });
  if (elements.releaseVersionText && loadingText && !loadingText.includes('·')) {
    renderReleaseBadge([]);
  }
}

function bindReleaseNotes() {
  if (!elements.releaseNotesBtn) return;
  elements.releaseNotesBtn.addEventListener('click', () => {
    void openReleaseNotes();
  });
  renderReleaseBadge(loadReleaseNotesCache() || []);
  scheduleDelayedIdleTask(() => {
    void fetchReleaseNotes().then((entries) => {
      renderReleaseBadge(entries);
    }).catch(() => {
      renderReleaseBadge([]);
    });
  }, 8000, 5000);
}

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

  elements.authForgotLogin?.addEventListener('click', () => {
    void requestPasswordReset();
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
      if (validated.user?.mustChangePassword) {
        const changeResult = await forceChangePasswordFlow(email, password);
        if (!changeResult.ok) {
          if (elements.authErrorLogin) elements.authErrorLogin.textContent = changeResult.error || 'No se pudo cambiar la contraseña.';
          return;
        }
        validated.user.mustChangePassword = false;
      }
      localStorage.setItem(AUTH_STORAGE_KEY, '1');
      saveAuthSession(validated.user);
      hideAuthGate();
      updateAuthUi();
      renderCatalog();
      scheduleSeedStartupWork();
      scheduleAuthenticatedStartupWork();
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
    renderCatalog();
    scheduleSeedStartupWork();
    scheduleAuthenticatedStartupWork();
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
  const localUsers = loadLocalAuthUsers();
  const localUser = localUsers[normalizedEmail];
  if (localUser?.salt && localUser?.passwordHash) {
    const localCandidate = await hashPassword(password, String(localUser.salt || ''));
    if (localCandidate === localUser.passwordHash) {
      return {
        ok: true,
        user: {
          name: localUser.name,
          email: normalizedEmail,
          role: localUser.role || 'viewer',
          mustChangePassword: Boolean(localUser.mustChangePassword)
        }
      };
    }
  }

  const user = await loadUserRecord(normalizedEmail).catch(() => null);
  if (!user) return { ok: false, error: 'Credenciales incorrectas.' };
  const candidate = await hashPassword(password, String(user.salt || ''));
  if (candidate !== user.passwordHash) return { ok: false, error: 'Credenciales incorrectas.' };
  cacheRemoteUserLocally(normalizedEmail, user);
  markLocalUserAsSynced(normalizedEmail, user);
  return { ok: true, user: { ...user, mustChangePassword: Boolean(user.mustChangePassword) } };
}

async function requestPasswordReset() {
  const presetEmail = String(elements.authEmailLogin?.value || '').trim().toLowerCase();
  const swal = window.Swal;

  let email = presetEmail;
  if (!email && swal?.fire) {
    const result = await swal.fire({
      title: 'Recuperar contraseña',
      input: 'email',
      inputLabel: '¿Cuál es tu email registrado en Devil TV?',
      inputPlaceholder: 'tu-email@ejemplo.com',
      showCancelButton: true,
      confirmButtonText: 'Continuar',
      cancelButtonText: 'Cancelar',
      inputValidator: (value) => {
        if (!value) return 'Escribe tu email';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Email no válido';
        return undefined;
      }
    });
    if (!result.isConfirmed) return;
    email = String(result.value || '').trim().toLowerCase();
  }
  if (!email) return;

  if (swal?.fire) {
    const confirm = await swal.fire({
      title: '¿Solicitar recuperación?',
      html: `Vamos a enviarte un link de recuperación a <strong>${escapeHtml(email)}</strong>.<br><br>` +
        'Recibirás un correo en pocos minutos con instrucciones para crear una nueva contraseña.<br><br>' +
        '<small style="opacity:0.7">Si tu email no está registrado, no recibirás nada — pero por seguridad no te lo confirmamos.</small>',
      showCancelButton: true,
      confirmButtonText: 'Enviar',
      cancelButtonText: 'Cancelar'
    });
    if (!confirm.isConfirmed) return;
  }

  try {
    if (swal?.fire) {
      swal.fire({
        title: 'Procesando…',
        allowOutsideClick: false,
        didOpen: () => swal.showLoading()
      });
    }

    await createPasswordResetIssue(email);

    if (swal?.fire) {
      await swal.fire({
        icon: 'success',
        title: 'Solicitud enviada',
        html: `Si <strong>${escapeHtml(email)}</strong> está registrado, recibirás un correo en pocos minutos con el link de recuperación.<br><br>Revisa también la carpeta de spam.`,
        confirmButtonText: 'Entendido'
      });
    }
  } catch (err) {
    if (swal?.fire) {
      await swal.fire({
        icon: 'error',
        title: 'Error',
        text: 'No se pudo procesar tu solicitud en este momento. Intenta de nuevo en unos minutos.',
        confirmButtonText: 'OK'
      });
    }
    console.error('[password-reset] create issue failed:', err);
  }
}

const RECOVERY_WORKER_BASE = 'https://devil-tv-recovery.hglerna.workers.dev';

async function forceChangePasswordFlow(email, currentPassword) {
  const swal = window.Swal;
  if (!swal?.fire) return { ok: false, error: 'UI no disponible.' };

  // Necesitamos el salt actual para computar el currentHash
  const localUsers = loadLocalAuthUsers();
  let salt = localUsers[email]?.salt;
  if (!salt) {
    const remote = await loadUserRecord(email).catch(() => null);
    salt = remote?.salt;
  }
  if (!salt) return { ok: false, error: 'No se pudo obtener el contexto del usuario.' };

  const result = await swal.fire({
    title: 'Cambia tu contraseña',
    html: `
      <p style="margin: 0 0 1rem; opacity: 0.85">Por seguridad debes establecer una nueva contraseña antes de continuar.</p>
      <input id="forcePw1" type="password" placeholder="Nueva contraseña" class="swal2-input" autocomplete="new-password" />
      <input id="forcePw2" type="password" placeholder="Confirmar contraseña" class="swal2-input" autocomplete="new-password" />
    `,
    showConfirmButton: true,
    confirmButtonText: 'Cambiar y continuar',
    showCancelButton: false,
    allowOutsideClick: false,
    allowEscapeKey: false,
    preConfirm: () => {
      const pw1 = document.getElementById('forcePw1').value;
      const pw2 = document.getElementById('forcePw2').value;
      if (!pw1 || pw1.length < 8) {
        swal.showValidationMessage('Mínimo 8 caracteres');
        return false;
      }
      if (pw1 !== pw2) {
        swal.showValidationMessage('Las contraseñas no coinciden');
        return false;
      }
      return pw1;
    }
  });
  if (!result.isConfirmed) return { ok: false, error: 'Cancelado' };

  const newPassword = result.value;

  swal.fire({ title: 'Guardando…', allowOutsideClick: false, didOpen: () => swal.showLoading() });

  try {
    const currentHash = await hashPassword(currentPassword, salt);
    const newSalt = makeSalt();
    const newHash = await hashPassword(newPassword, newSalt);

    const resp = await fetch(`${RECOVERY_WORKER_BASE}/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, currentHash, newSalt, newHash })
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }

    // Optimistic local cache update — login va a usar este hash inmediatamente
    try {
      const cache = JSON.parse(localStorage.getItem(AUTH_LOCAL_USERS_KEY) || '{}');
      cache[email] = {
        ...(cache[email] || {}),
        email,
        salt: newSalt,
        passwordHash: newHash,
        mustChangePassword: false,
        pendingSync: false,
        syncedAt: new Date().toISOString()
      };
      localStorage.setItem(AUTH_LOCAL_USERS_KEY, JSON.stringify(cache));
    } catch {}

    swal.close();
    return { ok: true };
  } catch (err) {
    await swal.fire({
      icon: 'error',
      title: 'Error',
      text: err.message || 'No se pudo cambiar la contraseña. Intenta de nuevo.'
    });
    return { ok: false, error: err.message || 'Error guardando.' };
  }
}

async function createPasswordResetIssue(email) {
  // Delegamos al Worker en Cloudflare. Él tiene un PAT con scope correcto
  // sobre lerna-soft/devil-tv; el cliente ya no maneja tokens de GitHub.
  const WORKER_URL = 'https://devil-tv-recovery.hglerna.workers.dev/request-reset';
  const response = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request reset failed (HTTP ${response.status})`);
  }
  return response.json();
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

function cacheRemoteUserLocally(email, remoteUser) {
  const key = String(email || '').trim().toLowerCase();
  if (!key || !remoteUser) return;
  const users = loadLocalAuthUsers();
  users[key] = {
    ...users[key],
    name: String(remoteUser?.name || users[key]?.name || key).trim(),
    role: String(remoteUser?.role || users[key]?.role || 'viewer').trim().toLowerCase(),
    salt: String(remoteUser?.salt || users[key]?.salt || ''),
    passwordHash: String(remoteUser?.passwordHash || users[key]?.passwordHash || ''),
    mustChangePassword: Boolean(remoteUser?.mustChangePassword),
    pendingSync: false,
    syncedAt: new Date().toISOString()
  };
  saveLocalAuthUsers(users);
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
  // Cache bust con timestamp real (no __mep_build): el sync workflow puede
  // escribir el data.json varias veces dentro de un mismo deploy, así que
  // necesitamos un cacheTag que cambie en cada llamada. Esto evita el caso
  // "sesión A inicia un título → sync push → sesión B carga 30s después
  // y obtiene un data.json stale del CDN porque el __mep_build no cambió".
  const cacheTag = Date.now();
  const primary = await fetchJsonWithTimeout(`./assets/watch-progress/users/${encodeURIComponent(normalizedEmail)}/data.json?v=${cacheTag}`).catch(() => null);
  return primary?.email ? primary : null;
}

async function hydrateWatchProgressForCurrentUser() {
  const user = getAuthUser();
  if (!user?.email) {
    dtvLog('warn', 'hydrateWatchProgressForCurrentUser skip — sin auth user. ' +
      'Continuar Viendo no se sincronizará hasta loguearse.');
    return;
  }
  const remote = await loadRemoteWatchProgress(user.email);
  watchProgressLastHydrate = Date.now();
  if (!remote) {
    dtvLog('sync', 'no remote watch-progress data.json for current user', { email: user.email });
    return;
  }
  dtvLog('sync', 'remote data.json fetched', {
    email: user.email,
    progressEntries: Object.keys(remote.progress || {}).length,
    historyEvents: (remote.history || []).length,
    hasPreferences: Boolean(remote.preferences),
    updatedAt: remote.updatedAt || null
  });
  mergeRemoteWatchProgress(remote);
  dtvLog('sync', 'mergeRemoteWatchProgress done → renderCatalog');
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
      catalogKey: getCanonicalCatalogKey(item?.type || 'movie', imdbId, tmdbId, item?.title || id, ''),
      type: String(item?.type || 'movie').trim() || 'movie',
      imdbId,
      tmdbId,
      title: String(item?.title || id).trim(),
      year: null,
      description: '',
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
  resetCatalogViewport();
  const search = getActiveSearchQuery();
  state.searchingTerm = getSearchInputValue();
  if (state.selected && !state.isSearching) {
    clearSelection({ closePlayer: true });
    renderDetail();
  }
  if (getSearchTermLength(search) >= 3 && searchSupportsRemote(search.mode)) {
    state.homeSectionView = null;
    state.isSearching = true;
    state.remoteResults = [];
    setCatalogCount(state.lastCountLabel || '0 títulos');
  }
  scheduleSearchCommit();
});
elements.typeFilter.addEventListener('change', () => {
  state.searchIntentId += 1;
  resetCatalogViewport();
  state.homeSectionView = null;
  clearSelection({ closePlayer: true });
  syncTabs(elements.typeFilter.value);
  renderCatalog();
  renderDetail();
  scheduleRemoteSearch();
});
elements.genreFilter?.addEventListener('change', () => {
  state.searchIntentId += 1;
  resetCatalogViewport();
  state.homeSectionView = null;
  if (state.selected) {
    clearSelection({ closePlayer: true });
    renderDetail();
  }
  renderCatalog();
  scheduleRemoteSearch();
});
elements.sortFilter?.addEventListener('change', () => {
  resetCatalogViewport();
  if (elements.search.value.trim().length > 0) state.homeSectionView = null;
  if (state.selected) {
    clearSelection({ closePlayer: true });
    renderDetail();
  }
  renderCatalog();
  if (state.remoteResults.length > 0 && elements.search.value.trim().length >= 3) {
    renderRemoteResults(elements.search.value.trim());
  }
});
elements.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const nextType = tab.dataset.typeTab;
    if (nextType === 'all') {
      resetCatalogViewport();
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
      clearSelection({ closePlayer: true });
      renderCatalog();
      renderDetail();
      syncRoute();
      return;
    }

    state.homeSectionView = null;
    resetCatalogViewport();
    clearSelection({ closePlayer: true });
    elements.typeFilter.value = nextType;
    syncTabs(nextType);
    renderCatalog();
    renderDetail();
    scheduleRemoteSearch();
  });
});

window.addEventListener('hashchange', handleRouteChange);
document.addEventListener('fullscreenchange', updateFullscreenButtonLabel);
document.addEventListener('webkitfullscreenchange', updateFullscreenButtonLabel);
bindPlayerModalEvents();
bindDetailEpisodeEvents();
primeCatalogHydrationStatus();
handleRouteChange();
scheduleSeedStartupWork();

if (isAuthenticated()) hideAuthGate();
else showAuthGate();

function scheduleSeedStartupWork() {
  if (!isAuthenticated()) return;
  dtvLog('boot', 'scheduleSeedStartupWork queued (bootstrap + delayed chunks)');
  scheduleAfterFirstPaint(() => {
    dtvLog('catalog', 'hydrateSeedCatalog(bootstrap) start');
    hydrateSeedCatalog({ bootstrap: true }).then((changed) => {
      dtvLog('catalog', 'hydrateSeedCatalog(bootstrap) done', { changed, localCount: loadLocalCatalog().length });
      if (changed) renderCatalogIfCurrentView();
      scheduleDelayedIdleTask(() => {
        dtvLog('catalog', 'hydrateSeedCatalog(chunks) start');
        hydrateSeedCatalog().then((c) => {
          dtvLog('catalog', 'hydrateSeedCatalog(chunks) done', { changed: c, localCount: loadLocalCatalog().length });
        }).catch((err) => dtvLog('catalog', 'hydrateSeedCatalog(chunks) error', String(err)));
      }, 3500, 2200);
    }).catch((err) => dtvLog('catalog', 'hydrateSeedCatalog(bootstrap) error', String(err)));
  });
}

function primeCatalogHydrationStatus() {
  if (!isAuthenticated() || isAdminUser()) return;
  const currentCount = loadLocalCatalog().length;
  if (currentCount >= 2000) return;
  state.catalogHydration = {
    active: true,
    loaded: currentCount,
    total: 0,
    phase: currentCount > 0 ? 'chunks-pending' : 'bootstrap'
  };
}

function getTmdbReadToken() {
  return decodeIssueToken(TMDB_READ_TOKEN_CIPHER, TMDB_READ_TOKEN_SEED);
}

function sanitizePosterUrl(value) {
  const poster = String(value || '').trim();
  if (!poster) return '';
  if (!/^https?:\/\//i.test(poster)) return '';
  if (/^description\s*:/i.test(poster)) return '';
  return poster;
}

function getCardPosterUrl(value) {
  const poster = sanitizePosterUrl(value);
  if (!poster) return '';
  return poster.replace('/t/p/w500/', '/t/p/w342/');
}

function isPlaceholderDescription(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return true;
  return text === 'sincronizado desde historial' || text === 'imdb result' || text === 'cargado desde ruta';
}

function hasWeakCatalogMetadata(title) {
  if (!title) return true;
  const description = String(title.description || '').trim();
  const posterUrl = sanitizePosterUrl(title.posterUrl || title.metadata?.posterUrl || '');
  const genres = Array.isArray(title.metadata?.genres) ? title.metadata.genres.filter(Boolean) : [];
  return !posterUrl || !description || isPlaceholderDescription(description) || !Number(title.year) || genres.length === 0;
}

async function resolvePosterForTitle(title) {
  if (!title || (!title.imdbId && !title.tmdbId)) return null;
  const tmdbType = title.type === 'series' ? 'tv' : 'movie';
  let tmdbId = title.tmdbId ? String(title.tmdbId).trim() : '';

  if (!tmdbId && title.imdbId) {
    const found = await tmdbFetchJson(`/find/${encodeURIComponent(title.imdbId)}`, { external_source: 'imdb_id', language: 'es-ES' }).catch(() => null);
    const pick = tmdbType === 'tv' ? (found?.tv_results?.[0] || null) : (found?.movie_results?.[0] || null);
    if (pick?.id) tmdbId = String(pick.id);
    const poster = sanitizePosterUrl(pick?.poster_path ? `https://image.tmdb.org/t/p/w500${pick.poster_path}` : '');
    if (poster) return { tmdbId, posterUrl: poster };
  }

  if (tmdbId) {
    const details = await tmdbFetchJson(`/${tmdbType}/${encodeURIComponent(tmdbId)}`, { language: 'es-ES' }).catch(() => null);
    const poster = sanitizePosterUrl(details?.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : '');
    if (poster) return { tmdbId, posterUrl: poster };
  }

  if (title.title) {
    const searchPath = tmdbType === 'tv' ? '/search/tv' : '/search/movie';
    const search = await tmdbFetchJson(searchPath, { query: title.title, language: 'es-ES', include_adult: 'false' }).catch(() => null);
    const candidates = Array.isArray(search?.results) ? search.results : [];
    const exact = candidates.find((item) => String(item?.name || item?.title || '').trim().toLowerCase() === String(title.title || '').trim().toLowerCase());
    const pick = exact || candidates[0] || null;
    const poster = sanitizePosterUrl(pick?.poster_path ? `https://image.tmdb.org/t/p/w500${pick.poster_path}` : '');
    if (poster) return { tmdbId: pick?.id ? String(pick.id) : tmdbId, posterUrl: poster };
  }

  return null;
}

function persistPosterForTitle(title) {
  if (!title) return;
  const current = loadLocalCatalog();
  saveLocalCatalog(dedupe([...current, normalizeSelection(title)], { consolidateEquivalent: true }));
}

async function ensurePosterForTitle(title, options = {}) {
  const { registerSeed = false } = options;
  if (!title) return '';
  const currentPoster = sanitizePosterUrl(title.posterUrl || title.metadata?.posterUrl || '');
  if (currentPoster) {
    if (registerSeed) queueCatalogSeedSyncForTitle(title);
    return currentPoster;
  }
  const resolved = await resolvePosterForTitle(title).catch(() => null);
  const posterUrl = sanitizePosterUrl(resolved?.posterUrl || '');
  if (!posterUrl) return '';
  title.posterUrl = posterUrl;
  title.tmdbId = title.tmdbId || resolved?.tmdbId || '';
  title.metadata = {
    ...(title.metadata || {}),
    posterUrl
  };
  persistPosterForTitle(title);
  if (registerSeed) queueCatalogSeedSyncForTitle(title);
  return posterUrl;
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

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqNames(values) {
  const seen = new Set();
  const names = [];
  for (const value of Array.isArray(values) ? values : []) {
    const name = String(value || '').trim();
    const key = normalizeSearchText(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function parseSearchQuery(rawQuery) {
  const raw = String(rawQuery || '').trim();
  if (!raw) return {
    mode: 'text',
    term: '',
    normalizedTerm: '',
    textTerm: '',
    nameTerm: '',
    actorTerm: '',
    directorTerm: '',
    genreTerm: '',
    yearTerm: '',
    typeFilter: 'all'
  };

  const clauses = raw.split(',').map((part) => String(part || '').trim()).filter(Boolean);
  let typeFilter = 'all';
  let textTerm = '';
  let nameTerm = '';
  let actorTerm = '';
  let directorTerm = '';
  let genreTerm = '';
  let yearTerm = '';

  for (const clause of clauses) {
    const match = clause.match(/^([a-zA-ZáéíóúÁÉÍÓÚñÑ]+)\s*:\s*(.+)$/);
    if (!match) {
      textTerm = [textTerm, clause].filter(Boolean).join(' ').trim();
      continue;
    }

    const prefix = normalizeSearchText(match[1]);
    const value = String(match[2] || '').trim();
    const normalizedValue = normalizeSearchText(value);
    if (!normalizedValue) continue;

    if (prefix === 'a' || prefix === 'actor') {
      actorTerm = value;
      continue;
    }
    if (prefix === 'n' || prefix === 'nombre' || prefix === 'name' || prefix === 'title' || prefix === 'titulo') {
      nameTerm = value;
      continue;
    }
    if (prefix === 'd' || prefix === 'director') {
      directorTerm = value;
      continue;
    }
    if (prefix === 'g' || prefix === 'genero' || prefix === 'genre') {
      genreTerm = value;
      continue;
    }
    if (prefix === 'y' || prefix === 'ano' || prefix === 'anio' || prefix === 'year') {
      yearTerm = value;
      continue;
    }
    if (prefix === 't' || prefix === 'tipo' || prefix === 'type') {
      if (['serie', 'series', 'tv'].includes(normalizedValue)) typeFilter = 'series';
      if (['pelicula', 'peliculas', 'movie', 'movies'].includes(normalizedValue)) typeFilter = 'movie';
      continue;
    }

    textTerm = [textTerm, clause].filter(Boolean).join(' ').trim();
  }

  const mode = actorTerm ? 'actor' : directorTerm ? 'director' : nameTerm ? 'name' : textTerm ? 'text' : genreTerm ? 'genre' : yearTerm ? 'year' : 'text';
  const term = actorTerm || directorTerm || nameTerm || textTerm || genreTerm || yearTerm || '';
  return {
    mode,
    term,
    normalizedTerm: normalizeSearchText(term),
    textTerm,
    nameTerm,
    actorTerm,
    directorTerm,
    genreTerm,
    yearTerm,
    typeFilter
  };
}

function getSearchInputValue() {
  return String(elements.search?.value || '').trim();
}

function getActiveSearchQuery() {
  return parseSearchQuery(getSearchInputValue());
}

function searchSupportsRemote(mode) {
  return mode === 'text' || mode === 'name' || mode === 'actor' || mode === 'director';
}

function getSearchTermLength(search) {
  return String(search?.normalizedTerm || '').length;
}

function getEffectiveTypeFilter(search = getActiveSearchQuery()) {
  return search?.typeFilter && search.typeFilter !== 'all'
    ? search.typeFilter
    : (elements.typeFilter?.value || 'all');
}

function matchesSearchFilters(title, search) {
  const query = search || getActiveSearchQuery();
  const type = getEffectiveTypeFilter(query);
  const genres = (title?.metadata?.genres || title?.categories || []).map((g) => String(g || '').trim());
  const cast = Array.isArray(title?.metadata?.cast) ? title.metadata.cast : [];
  const directors = Array.isArray(title?.metadata?.directors) ? title.metadata.directors : [];
  const year = String(title?.year || '').trim();
  const titleHaystack = normalizeSearchText([title?.title, title?.showTitle, title?.metadata?.originalTitle].join(' '));
  const textHaystack = normalizeSearchText([title?.title, title?.showTitle, title?.imdbId, title?.tmdbId, ...genres, ...cast, ...directors].join(' '));

  if (type !== 'all' && title?.type !== type) return false;
  if (query.textTerm && !textHaystack.includes(normalizeSearchText(query.textTerm))) return false;
  if (query.nameTerm && !titleHaystack.includes(normalizeSearchText(query.nameTerm))) return false;
  if (query.actorTerm && !cast.some((name) => normalizeSearchText(name).includes(normalizeSearchText(query.actorTerm)))) return false;
  if (query.directorTerm && !directors.some((name) => normalizeSearchText(name).includes(normalizeSearchText(query.directorTerm)))) return false;
  if (query.genreTerm && !genres.some((name) => normalizeSearchText(name).includes(normalizeSearchText(query.genreTerm)))) return false;
  if (query.yearTerm && year !== normalizeSearchText(query.yearTerm)) return false;
  return true;
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
  const wasWeakBeforeHydration = hasWeakCatalogMetadata(title);
  if (cached && cached.payload && !hasWeakCatalogMetadata({ ...title, ...cached.payload })) {
    Object.assign(title, cached.payload);
    persistPosterForTitle(title);
    if (existsInSeedCatalog(title) && wasWeakBeforeHydration) {
      queueCatalogMetadataRepairForTitle(title, 'cached_tmdb_metadata_completed');
    } else if (!existsInSeedCatalog(title)) {
      queueCatalogSeedSyncForTitle(title);
    }
    return;
  }

  try {
    let tmdbType = title.type === 'series' ? 'tv' : 'movie';
    let tmdbId = title.tmdbId ? String(title.tmdbId) : '';

    if (!tmdbId && title.imdbId) {
      const found = await tmdbFetchJson(`/find/${encodeURIComponent(title.imdbId)}`, { external_source: 'imdb_id', language: 'es-ES' });
      const pick = tmdbType === 'tv' ? (found.tv_results?.[0] || null) : (found.movie_results?.[0] || null);
      if (pick?.id) tmdbId = String(pick.id);
      if (pick?.poster_path && !sanitizePosterUrl(title.posterUrl)) title.posterUrl = `https://image.tmdb.org/t/p/w500${pick.poster_path}`;
      if (pick?.overview && isPlaceholderDescription(title.description)) title.description = pick.overview;
    }

    if (!tmdbId) return;

    const details = await tmdbFetchJson(`/${tmdbType}/${encodeURIComponent(tmdbId)}`, { language: 'es-ES' });
    const credits = await tmdbFetchJson(`/${tmdbType}/${encodeURIComponent(tmdbId)}/credits`, { language: 'es-ES' });

    const genres = (details.genres || []).map((g) => g.name).filter(Boolean);
    const castNames = uniqNames((credits.cast || []).slice(0, 10).map((c) => c.name));
    const directorNames = uniqNames((credits.crew || []).filter((c) => String(c?.job || '').trim().toLowerCase() === 'director').map((c) => c.name));
    const endYear = tmdbType === 'tv' && details.last_air_date ? String(details.last_air_date).slice(0, 4) : '';
    const backdropUrl = details.backdrop_path ? `https://image.tmdb.org/t/p/w780${details.backdrop_path}` : '';
    const posterUrl = details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : '';

    const payload = {
      tmdbId,
      title: title.title || details.name || details.title || title.title,
      year: Number(String((details.first_air_date || details.release_date || '')).slice(0, 4)) || title.year,
      description: details.overview || (isPlaceholderDescription(title.description) ? '' : title.description),
      posterUrl: sanitizePosterUrl(title.posterUrl) || posterUrl,
      metadata: {
        ...(title.metadata || {}),
        posterUrl: sanitizePosterUrl(title.metadata?.posterUrl) || sanitizePosterUrl(title.posterUrl) || posterUrl,
        releaseDate: details.first_air_date || details.release_date || (title.metadata?.releaseDate ?? null),
        originalTitle: details.original_title || details.original_name || (title.metadata?.originalTitle ?? ''),
        genres,
        cast: castNames,
        directors: directorNames,
        endYear: endYear || (title.metadata?.endYear ?? ''),
        backdropUrl: backdropUrl || (title.metadata?.backdropUrl ?? null)
      }
    };

    Object.assign(title, payload);
    persistPosterForTitle(title);
    if (existsInSeedCatalog(title)) {
      if (wasWeakBeforeHydration || hasWeakCatalogMetadata(title)) {
        queueCatalogMetadataRepairForTitle(title, hasWeakCatalogMetadata(title) ? 'tmdb_metadata_still_incomplete' : 'tmdb_metadata_completed');
      }
    } else {
      queueCatalogSeedSyncForTitle(title);
    }
    cache[key] = { cachedAt: Date.now(), payload };
    saveTmdbMetaCache(cache);
    if (existsInSeedCatalog(title) && hasWeakCatalogMetadata(title)) {
      queueCatalogMetadataRepairForTitle(title, 'tmdb_metadata_missing_after_hydration');
    }
  } catch {
    if (existsInSeedCatalog(title) && wasWeakBeforeHydration) {
      queueCatalogMetadataRepairForTitle(title, 'tmdb_hydration_failed');
    }
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
    elements.logoutBtn.textContent = authenticated ? 'Salir' : 'Entrar';
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
  updateFloatingReportButtonVisibility();
}

updateAuthUi();
bindReleaseNotes();
scheduleAuthenticatedStartupWork();

function scheduleAfterFirstPaint(callback) {
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => window.setTimeout(callback, 0));
    return;
  }
  window.setTimeout(callback, 0);
}

function scheduleIdleTask(callback, timeoutMs = 1500) {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(callback, { timeout: timeoutMs });
    return;
  }
  window.setTimeout(callback, timeoutMs);
}

function scheduleDelayedIdleTask(callback, delayMs = 1000, timeoutMs = 1500) {
  window.setTimeout(() => scheduleIdleTask(callback, timeoutMs), delayMs);
}

function renderCatalogIfCurrentView() {
  if (!elements.appShell || elements.appShell.hidden) return;
  if (document.body.classList.contains('detail-active')) return;
  renderCatalog();
}

function scheduleCatalogHydrationRender(delayMs = 700) {
  if (!elements.appShell || elements.appShell.hidden) return;
  if (document.body.classList.contains('detail-active')) return;
  if (state.catalogHydrationRenderTimer) return;
  state.catalogHydrationRenderTimer = window.setTimeout(() => {
    state.catalogHydrationRenderTimer = null;
    if (!elements.appShell || elements.appShell.hidden) return;
    if (document.body.classList.contains('detail-active')) return;
    renderCatalog();
  }, delayMs);
}

function getCatalogHydrationMessage() {
  if (!state.catalogHydration?.active) return '';
  if (state.catalogHydration.phase === 'bootstrap') return 'Preparando catálogo inicial';
  if (state.catalogHydration.phase === 'chunks-pending') return 'Preparando carga progresiva';
  return 'Cargando catálogo';
}

function getCatalogHydrationPercent() {
  if (!state.catalogHydration?.active) return 0;
  const loaded = Number(state.catalogHydration.loaded || 0);
  const total = Number(state.catalogHydration.total || 0);
  if (total > 0 && loaded > 0) return Math.max(8, Math.min(96, Math.round((loaded / total) * 100)));
  if (state.catalogHydration.phase === 'bootstrap') return 8;
  if (state.catalogHydration.phase === 'chunks-pending') return 18;
  return 12;
}

function renderCatalogHydrationStatus() {
  const message = getCatalogHydrationMessage();
  if (!message) return '';
  const percent = getCatalogHydrationPercent();
  return `<section class="catalog-loading-status" role="status" aria-live="polite" aria-label="${escapeAttribute(`${message}. ${percent}%`)}">
    <div class="catalog-loading-orb" aria-hidden="true"><span>${escapeHtml(String(percent))}%</span></div>
    <div class="catalog-loading-copy">
      <strong>${escapeHtml(message)}</strong>
      <p>Estamos armando las secciones en segundo plano. Puedes empezar a explorar mientras el catálogo se completa.</p>
      <div class="catalog-loading-progress" aria-hidden="true"><span style="width: ${escapeAttribute(`${percent}%`)}"></span></div>
    </div>
  </section>`;
}

function scheduleAuthenticatedStartupWork() {
  if (!isAuthenticated()) return;
  dtvLog('boot', 'scheduleAuthenticatedStartupWork queued (~3s idle)');
  scheduleDelayedIdleTask(() => {
    dtvLog('sync', 'hydrateWatchProgressForCurrentUser start');
    hydrateWatchProgressForCurrentUser().finally(() => {
      scheduleDelayedIdleTask(() => {
        dtvLog('queue', 'startWatchProgressQueueHeartbeat scheduled');
        startWatchProgressQueueHeartbeat();
      }, 6000, 4000);
    });
  }, 3000, 1800);
  installVisibilityRehydrate();
}

// Re-hidrata el progreso remoto cuando la pestaña vuelve a foreground después
// de >= 60s en background. Resuelve el caso clásico mobile: usuario inicia un
// título en sesión A (otro device/perfil), bloquea pantalla en sesión B, y al
// desbloquear espera ver "Continuar viendo" actualizado. Sin esto, sesión B
// solo re-hidrata en boot. El throttle de 60s evita refetch en cada blur.
// (Declaraciones movidas arriba — ver top del módulo, mismo motivo TDZ que
// homeRenderToken.)
function installVisibilityRehydrate() {
  if (visibilityRehydrateBound) return;
  visibilityRehydrateBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!isAuthenticated()) return;
    const since = Date.now() - watchProgressLastHydrate;
    if (since < 60_000) {
      dtvLog('sync', 'visibilitychange skip rehydrate (throttle)', { sinceMs: since });
      return;
    }
    dtvLog('sync', 'visibilitychange → rehydrate', { sinceMs: since });
    watchProgressLastHydrate = Date.now();
    hydrateWatchProgressForCurrentUser().catch((err) => {
      dtvLog('error', 'visibilitychange rehydrate failed', String(err));
    });
  });
}

async function loadSeedVersionHint() {
  const hint = await fetchJsonWithTimeout(`${SEED_VERSION_HINT_PATH}?v=${window.__mep_build || ''}`, 1200).catch(() => null);
  const version = Number(hint?.version || 0);
  return Number.isFinite(version) ? version : 0;
}

function normalizeSeedItems(seed) {
  const items = [];
  for (const entry of seed?.movies ?? []) {
    items.push(normalizeSeedEntry(entry, 'movie'));
  }
  for (const entry of seed?.series ?? []) {
    items.push(normalizeSeedEntry(entry, 'series'));
  }
  for (const entry of seed?.items ?? []) {
    items.push(normalizeSeedEntry(entry, entry?.type || 'movie'));
  }
  return items;
}

function storeSeedCatalogKeys(items) {
  try {
    const keys = dedupe(items, { consolidateEquivalent: true })
      .map((entry) => getSeedSyncKey(entry))
      .filter(Boolean);
    localStorage.setItem(SEED_CATALOG_KEYS_STORAGE, JSON.stringify(keys));
  } catch {}
}

async function hydrateSeedCatalogChunks(current, hintedVersion = 0) {
  const index = await fetchJsonWithTimeout(`${SEED_CHUNKS_INDEX_PATH}?v=${window.__mep_build || ''}`, 1500).catch(() => null);
  const chunks = Array.isArray(index?.chunks) ? index.chunks : [];
  dtvLog('catalog', 'chunks index loaded', { chunks: chunks.length, version: index?.version || 0, total: index?.total || 0 });
  if (!chunks.length) {
    state.catalogHydration.active = false;
    scheduleCatalogHydrationRender(0);
    return false;
  }

  const seedVersion = Number(index?.version || hintedVersion || 0);
  const expectedTotal = Number(index?.total || 0);
  let merged = Array.isArray(current) ? current : [];
  const allSeedItems = [];
  let loadedCount = 0;
  state.catalogHydration = {
    active: true,
    loaded: merged.length,
    total: expectedTotal || merged.length,
    phase: 'chunks'
  };
  scheduleCatalogHydrationRender(0);

  for (const chunk of chunks) {
    const file = String(chunk?.file || '').trim();
    if (!file) continue;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    const seed = await fetchJsonWithTimeout(`./assets/catalog.chunks/${encodeURIComponent(file)}?v=${window.__mep_build || ''}`, 2500).catch(() => null);
    const items = normalizeSeedItems(seed);
    if (!items.length) {
      dtvLog('catalog', 'chunk empty/failed', { file });
      continue;
    }
    dtvLog('catalog', 'chunk loaded', { file, items: items.length, loadedSoFar: loadedCount + items.length, total: expectedTotal });
    loadedCount += items.length;
    allSeedItems.push(...items);
    merged = dedupe([...merged, ...items]);
    state.catalogHydration.loaded = merged.length;
    state.catalogHydration.total = expectedTotal || merged.length;
    setRuntimeCatalog(merged);
    // No re-render per chunk: el user pidió que el proceso de hydration sea
    // silencioso en background. UN solo render final cuando termine el loop
    // (línea ~1983, scheduleCatalogHydrationRender(0)).
  }

  if (!allSeedItems.length) {
    state.catalogHydration.active = false;
    scheduleCatalogHydrationRender(0);
    return false;
  }
  state.catalogHydration.active = false;
  scheduleCatalogHydrationRender(0);
  if (!expectedTotal || loadedCount >= expectedTotal) {
    storeSeedCatalogKeys(allSeedItems);
  }
  return true;
}

async function hydrateSeedCatalog(options = {}) {
  const bootstrap = options.bootstrap === true;
  const current = loadLocalCatalog();
  const hasLocalCatalog = Array.isArray(current) && current.length > 0;
  if (bootstrap && hasLocalCatalog) return false;

  if (!bootstrap && hasLocalCatalog) {
    const hintedVersion = await loadSeedVersionHint();
    const appliedVersion = Number(localStorage.getItem('mep_seed_version') || '0');
    if (hintedVersion && appliedVersion === hintedVersion) return false;
  }

  if (!bootstrap) {
    const chunked = await hydrateSeedCatalogChunks(current);
    if (chunked) return true;
  }

  const seedUrl = bootstrap
    ? `${SEED_BOOTSTRAP_PATH}?v=${window.__mep_build || ''}`
    : `./assets/catalog.seed.json?v=${window.__mep_build || ''}`;
  if (bootstrap) {
    state.catalogHydration = {
      active: true,
      loaded: current.length,
      total: 0,
      phase: 'bootstrap'
    };
    scheduleCatalogHydrationRender(0);
  }
  const response = await fetch(seedUrl, { cache: 'no-store' }).catch(() => null);
  if (!response?.ok) {
    if (bootstrap) state.catalogHydration.active = false;
    scheduleCatalogHydrationRender(0);
    return false;
  }
  const seed = await response.json().catch(() => null);
  if (!seed || (!Array.isArray(seed.movies) && !Array.isArray(seed.series))) {
    if (bootstrap) state.catalogHydration.active = false;
    scheduleCatalogHydrationRender(0);
    return false;
  }

  const seedVersion = Number(seed.version || 0);
  const versionKey = bootstrap ? SEED_BOOTSTRAP_VERSION_STORAGE : 'mep_seed_version';
  const appliedVersion = Number(localStorage.getItem(versionKey) || '0');
  if (seedVersion && appliedVersion === seedVersion && hasLocalCatalog) {
    if (bootstrap) state.catalogHydration.active = false;
    scheduleCatalogHydrationRender(0);
    return false;
  }

  const items = normalizeSeedItems(seed);
  storeSeedCatalogKeys(items);

  const merged = dedupe([...current, ...items]);
  saveLocalCatalog(merged);
  if (seedVersion) localStorage.setItem(versionKey, String(seedVersion));
  if (bootstrap) {
    state.catalogHydration.loaded = merged.length;
    state.catalogHydration.total = 0;
    state.catalogHydration.phase = 'chunks-pending';
    scheduleCatalogHydrationRender(0);
  } else {
    state.catalogHydration.active = false;
  }
  return true;
}

function normalizeSeedEntry(entry, defaultType) {
  const type = entry?.type || defaultType;
  const tmdbId = entry?.tmdbId ? String(entry.tmdbId) : '';
  const imdbId = entry?.imdbId ? String(entry.imdbId) : '';
  const id = imdbId || tmdbId;
  const title = entry?.title || '';
  const year = Number(entry?.year) || null;
  const description = entry?.overview || entry?.description || '';
  const posterUrl = sanitizePosterUrl(entry?.posterUrl || '');
  const playable = type === 'series' ? (entry?.playable ?? true) : true;
  return {
    catalogKey: getCanonicalCatalogKey(type, imdbId, tmdbId, title, year),
    type,
    imdbId,
    tmdbId,
    title,
    year,
    description,
    posterUrl,
    playable,
    metadata: {
      posterUrl,
      releaseDate: entry?.releaseDate || null,
      originalTitle: entry?.originalTitle || entry?.originalName || '',
      genres: entry?.genres || [],
      cast: Array.isArray(entry?.cast) ? uniqNames(entry.cast) : [],
      directors: Array.isArray(entry?.directors) ? uniqNames(entry.directors) : [],
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

function getCanonicalExternalId(entry) {
  return String(entry?.tmdbId || entry?.imdbId || entry?.catalogKey || '').trim();
}

function getCanonicalCatalogKey(type, imdbId, tmdbId, title = '', year = '') {
  const normalizedType = String(type || 'movie').trim() || 'movie';
  const canonicalId = String(tmdbId || imdbId || '').trim();
  if (canonicalId) return `${normalizedType}:canonical:${canonicalId}`;
  return `${normalizedType}:title:${String(title || '').trim().toLowerCase()}:${String(year || '').trim()}`;
}

function getPlaybackTitleKey(entry) {
  return String(entry?.imdbId || entry?.tmdbId || '').trim();
}

function getTitleId(title) {
  return getCanonicalExternalId(title);
}

function getTitlePreferenceKeys(title) {
  const keys = [
    getCanonicalExternalId(title),
    String(title?.imdbId || '').trim(),
    String(title?.tmdbId || '').trim(),
    String(title?.catalogKey || '').trim()
  ].filter(Boolean);
  return [...new Set(keys)];
}

function readTitlePreferenceValue(map, title, fallback = 0) {
  const source = map && typeof map === 'object' ? map : {};
  for (const key of getTitlePreferenceKeys(title)) {
    if (source[key] !== undefined) return source[key];
  }
  return fallback;
}

function writeTitlePreferenceValue(map, title, value) {
  const source = map && typeof map === 'object' ? map : {};
  const keys = getTitlePreferenceKeys(title);
  if (!keys.length) return source;
  for (const key of keys) {
    if (value === undefined || value === null || value === false || value === 0) delete source[key];
    else source[key] = value;
  }
  return source;
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

// Delegamos al Worker en Cloudflare. El PAT ofuscado del cliente fue creado
// para el repo viejo (lerna-admin/media-evaluation-platform-static) y no
// tiene scope para lerna-soft/devil-tv. El Worker tiene su propio PAT con
// permisos correctos y crea labels que falten on-demand.
async function openGitHubIssue(title, body, labels = []) {
  const labelsArr = [...new Set(
    (Array.isArray(labels) ? labels : [labels])
      .map((s) => String(s || '').trim())
      .filter(Boolean)
  )];
  const WORKER_URL = 'https://devil-tv-recovery.hglerna.workers.dev/create-issue';
  const response = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, labels: labelsArr })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `GitHub issue create failed (HTTP ${response.status})`);
  }
  return response.json();
}

// Delegan al Worker (mismo motivo que openGitHubIssue: el PAT viejo ofuscado en
// el cliente fue creado para el repo viejo lerna-admin/media-evaluation-platform-static
// y no tiene scope sobre lerna-soft/devil-tv. El Worker tiene su propio GITHUB_PAT
// con permisos correctos.
const WORKER_BASE = 'https://devil-tv-recovery.hglerna.workers.dev';

async function workerListIssues(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const resp = await fetch(`${WORKER_BASE}/list-issues?${qs}`);
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || `list-issues failed (HTTP ${resp.status})`);
  }
  return resp.json();
}

async function workerListWorkflowRuns(workflow, perPage = 10) {
  const qs = new URLSearchParams({ workflow, per_page: String(perPage) }).toString();
  const resp = await fetch(`${WORKER_BASE}/list-workflow-runs?${qs}`);
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || `list-runs failed (HTTP ${resp.status})`);
  }
  return resp.json();
}

async function workerDispatchWorkflow(workflow, ref = 'main') {
  const resp = await fetch(`${WORKER_BASE}/dispatch-workflow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow, ref })
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || `dispatch failed (HTTP ${resp.status})`);
  }
  return resp.json();
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
    const openIssues = await workerListIssues({ state: 'open', labels: 'watch-progress-sync', per_page: '1' });
    const openCount = Array.isArray(openIssues) ? openIssues.length : 0;
    if (openCount <= 0) return;

    const resolveRuns = await workerListWorkflowRuns('resolve-watch-progress-issue.yml', 10);
    const drainRuns = await workerListWorkflowRuns('drain-watch-progress-queue.yml', 10);
    const hasActiveRun = [...(resolveRuns?.workflow_runs || []), ...(drainRuns?.workflow_runs || [])]
      .some((run) => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(String(run?.status || '').toLowerCase()));
    if (hasActiveRun) return;

    const lastDispatchAt = Number(localStorage.getItem(WATCH_PROGRESS_HEARTBEAT_DISPATCH_KEY) || '0');
    if (lastDispatchAt && (now - lastDispatchAt) < WATCH_PROGRESS_HEARTBEAT_DISPATCH_WINDOW_MS) return;

    await workerDispatchWorkflow('drain-watch-progress-queue.yml', 'main');
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

function extractBodyField(body, label) {
  const match = String(body || '').match(new RegExp(`^${String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[ \\t]*(.*)$`, 'im'));
  return String(match?.[1] || '').trim();
}

function shouldShowFloatingReportButton() {
  if (!isAuthenticated()) return false;
  if (isAdminUser()) return false;
  if (!elements.appShell || elements.appShell.hidden) return false;
  if (elements.playerModal && !elements.playerModal.hidden) return false;
  return true;
}

function updateFloatingReportButtonVisibility() {
  if (!elements.floatingReportBtn) return;
  elements.floatingReportBtn.hidden = !shouldShowFloatingReportButton();
}

function buildUserProblemIssueBody(context, report) {
  const user = getAuthUser();
  const safeContext = context && typeof context === 'object' ? context : {};
  return [
    'USER_PROBLEM_REPORT',
    `ReportedByEmail: ${String(user?.email || '').trim().toLowerCase()}`,
    `ReportedByName: ${String(user?.name || '').trim()}`,
    `ReportedAt: ${new Date().toISOString()}`,
    `ReportScope: ${String(safeContext.scope || 'general').trim().toLowerCase()}`,
    `ProblemCategory: ${String(report?.category || '').trim()}`,
    `ProblemSummary: ${String(report?.summary || '').trim()}`,
    safeContext.title ? `Title: ${String(safeContext.title).trim()}` : '',
    safeContext.type ? `Type: ${String(safeContext.type).trim()}` : '',
    safeContext.imdbId ? `IMDb: ${String(safeContext.imdbId).trim()}` : '',
    safeContext.tmdbId ? `TMDB: ${String(safeContext.tmdbId).trim()}` : '',
    safeContext.season ? `Season: ${positiveInteger(safeContext.season, 1)}` : '',
    safeContext.episode ? `Episode: ${positiveInteger(safeContext.episode, 1)}` : '',
    safeContext.episodeTitle ? `EpisodeTitle: ${String(safeContext.episodeTitle).trim()}` : '',
    '',
    'Observed issue:',
    String(report?.description || '').trim(),
    '',
    'Expected behavior:',
    String(report?.expected || '').trim() || 'The feature should work correctly.',
    '',
    `Page: ${window.location.href}`
  ].filter(Boolean).join('\n');
}

async function openUserProblemReportForm(context = {}) {
  const user = getAuthUser();
  if (!user?.email) {
    showAuthGate();
    return;
  }
  if (isAdminUser()) return;
  const swal = window.Swal;
  const safeContext = context && typeof context === 'object' ? context : {};
  const scope = String(safeContext.scope || 'general').trim().toLowerCase();
  const label = String(safeContext.label || safeContext.title || 'plataforma').trim();
  const issueLabels = [
    USER_REPORT_LABEL,
    scope === 'episode'
      ? USER_REPORT_EPISODE_LABEL
      : scope === 'title'
        ? USER_REPORT_TITLE_LABEL
        : USER_REPORT_PLATFORM_LABEL
  ];

  if (!swal?.fire) {
    const description = window.prompt(`Describe el problema de ${label}:`, '');
    if (!description || !description.trim()) return;
    try {
      await openGitHubIssue(`User report: ${label}`, buildUserProblemIssueBody(safeContext, {
        category: scope === 'episode' ? 'episode_problem' : scope === 'title' ? 'title_problem' : 'platform_problem',
        summary: `Reporte de ${label}`,
        description: description.trim(),
        expected: ''
      }), issueLabels);
    } catch (error) {
      console.error(error);
      void notifyIssueCreationError(error);
    }
    return;
  }

  const categoryOptions = scope === 'episode'
    ? `
      <option value="playback_error">No reproduce</option>
      <option value="wrong_episode">Capítulo incorrecto</option>
      <option value="subtitle_audio">Audio o subtítulos</option>
      <option value="other">Otro</option>
    `
    : scope === 'title'
      ? `
        <option value="playback_error">No reproduce</option>
        <option value="metadata_error">Información incorrecta</option>
        <option value="missing_content">Faltan capítulos o versiones</option>
        <option value="other">Otro</option>
      `
      : `
        <option value="platform_bug">Error de la plataforma</option>
        <option value="account_issue">Problema con la cuenta</option>
        <option value="search_issue">Problema buscando contenido</option>
        <option value="other">Otro</option>
      `;

  const result = await swal.fire({
    title: 'Reportar problema',
    html: `
      <div style="display:grid;gap:0.8rem;text-align:left;">
        <p style="margin:0;color:#cfd3da;font-size:0.92rem;">Contexto: <strong style="color:#fff;">${escapeHtml(label)}</strong></p>
        <select id="reportCategory" class="swal2-input" style="margin:0;">${categoryOptions}</select>
        <input id="reportSummary" class="swal2-input" placeholder="Resumen corto del problema" style="margin:0;" />
        <textarea id="reportDescription" class="swal2-textarea" placeholder="Describe el problema con detalle" style="margin:0;min-height:120px;"></textarea>
        <textarea id="reportExpected" class="swal2-textarea" placeholder="Qué esperabas que pasara" style="margin:0;min-height:90px;"></textarea>
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: 'Enviar reporte',
    cancelButtonText: 'Cancelar',
    focusConfirm: false,
    preConfirm: () => {
      const category = String(document.querySelector('#reportCategory')?.value || '').trim();
      const summary = String(document.querySelector('#reportSummary')?.value || '').trim();
      const description = String(document.querySelector('#reportDescription')?.value || '').trim();
      const expected = String(document.querySelector('#reportExpected')?.value || '').trim();
      if (!summary || !description) {
        swal.showValidationMessage('Completa el resumen y la descripción del problema.');
        return null;
      }
      return { category, summary, description, expected };
    }
  });

  if (!result.isConfirmed || !result.value) return;

  try {
    await openGitHubIssue(`User report: ${label}`, buildUserProblemIssueBody(safeContext, result.value), issueLabels);
    await swal.fire({
      icon: 'success',
      title: 'Reporte enviado',
      text: 'Tu reporte fue enviado correctamente.',
      timer: 2200,
      showConfirmButton: false
    });
  } catch (error) {
    console.error(error);
    void notifyIssueCreationError(error);
  }
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
  if (lastAt && (now - lastAt) < windowMs) {
    dtvLog('queue', 'queueWatchProgressSync deduped', {
      titleId, eventType, key, ageMs: now - lastAt, windowMs
    });
    return;
  }
  localStorage.setItem(dedupe, String(now));

  try {
    dtvLog('queue', 'queueWatchProgressSync emitting issue', { titleId, eventType, key });
    await openGitHubIssue(
      `Watch progress: ${user.name || user.email} <${user.email}>`,
      buildWatchProgressIssueBody({
        ...snapshot,
        email: user.email,
        name: user.name
      }),
      [WATCH_PROGRESS_SYNC_LABEL]
    );
    dtvLog('queue', 'queueWatchProgressSync issue created', { titleId, eventType });
  } catch (err) {
    dtvLog('queue', 'queueWatchProgressSync issue failed (local kept)', { titleId, eventType, err: String(err) });
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
    `ReleaseDate: ${String(title?.metadata?.releaseDate || '').trim()}`,
    `BackdropUrl: ${String(title?.metadata?.backdropUrl || '').trim()}`,
    `Genres: ${Array.isArray(title?.metadata?.genres) ? title.metadata.genres.filter(Boolean).join(', ') : ''}`,
    `Page: ${window.location.href}`,
    `CreatedAt: ${new Date().toISOString()}`
  ].join('\n');
}

function getCatalogMissingFields(title) {
  const missing = [];
  if (!sanitizePosterUrl(title?.posterUrl || title?.metadata?.posterUrl || '')) missing.push('poster');
  if (isPlaceholderDescription(title?.description || '')) missing.push('description');
  if (!Number(title?.year)) missing.push('year');
  if (!Array.isArray(title?.metadata?.genres) || title.metadata.genres.filter(Boolean).length === 0) missing.push('genres');
  return missing;
}

function buildCatalogMetadataRepairIssueBody(title, reason = '') {
  return [
    'CATALOG_METADATA_REPAIR_REQUEST',
    `RepairReason: ${String(reason || '').trim()}`,
    `MissingFields: ${getCatalogMissingFields(title).join(', ')}`,
    buildCatalogSeedSyncIssueBody(title)
  ].filter(Boolean).join('\n');
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

function queueCatalogMetadataRepairForTitle(title, reason = '') {
  const dedupeKey = getSeedSyncKey(title);
  if (!dedupeKey) return;
  const onceKey = `${SEED_METADATA_REPAIR_DEDUPE_PREFIX}${dedupeKey}`;
  const now = Date.now();
  const lastAt = Number(localStorage.getItem(onceKey) || '0');
  if (lastAt && (now - lastAt) < SEED_SYNC_WINDOW_MS) return;
  localStorage.setItem(onceKey, String(now));
  void openGitHubIssue(
    `Catalog metadata repair: ${String(title?.title || dedupeKey)}`,
    buildCatalogMetadataRepairIssueBody(title, reason),
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

function playEpisodeCard(card) {
  if (!card || !state.selected || !isSeriesLike(state.selected)) return;
  state.playback.episode = positiveInteger(card.dataset.episode, 1);
  openPlayerForCurrentSelection();
}

function bindDetailEpisodeEvents() {
  if (!elements.detail) return;
  const resolveCard = (event) => {
    if (!(event.target instanceof Element)) return null;
    if (event.target.closest('button, a, input, textarea, select')) return null;
    return event.target.closest('.episode-card[data-episode]');
  };
  elements.detail.addEventListener('pointerup', (event) => {
    const card = resolveCard(event);
    if (!card) return;
    detailEpisodePointerHandledAt = Date.now();
    event.preventDefault?.();
    event.stopPropagation?.();
    playEpisodeCard(card);
  }, { passive: false });
  elements.detail.addEventListener('click', (event) => {
    const card = resolveCard(event);
    if (!card) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    if (Date.now() - detailEpisodePointerHandledAt < 600) return;
    playEpisodeCard(card);
  });
}

bindTap(elements.floatingReportBtn, () => {
  void openUserProblemReportForm({
    scope: 'general',
    label: 'plataforma'
  });
});

bindTap(elements.searchHelpBtn, () => {
  openSearchHelp();
});

function getBrowseHeading() {
  const type = elements.typeFilter?.value || 'all';
  if (type === 'movie') return 'Películas';
  if (type === 'series') return 'Series';
  return 'Inicio';
}

function openSearchHelp() {
  void Swal.fire({
    title: 'Cómo usar el buscador',
    html: `
      <div style="text-align:left; display:grid; gap:0.65rem;">
        <p style="margin:0;">También puedes buscar normalmente por texto libre.</p>
        <p style="margin:0;">Si combinas filtros, sepáralos con comas.</p>
        <p style="margin:0;"><strong>t:</strong> tipo. Ejemplos: <code>t:serie</code> o <code>t:pelicula</code></p>
        <p style="margin:0;"><strong>n:</strong> nombre del título. Ejemplo: <code>n:transporter</code></p>
        <p style="margin:0;"><strong>a:</strong> actor. Ejemplo: <code>a:Jackie Chan</code></p>
        <p style="margin:0;"><strong>d:</strong> director. Ejemplo: <code>d:Christopher Nolan</code></p>
        <p style="margin:0;"><strong>g:</strong> género. Ejemplo: <code>g:drama</code></p>
        <p style="margin:0;"><strong>y:</strong> año. Ejemplo: <code>y:2024</code></p>
        <p style="margin:0;"><strong>ano:</strong> alias de año. Ejemplo: <code>ano:2024</code></p>
        <p style="margin:0;">Puedes combinarlos. Ejemplo: <code>n:transporter, a:jason statham, t:pelicula</code></p>
      </div>
    `,
    confirmButtonText: 'Entendido'
  });
}

function renderCatalog() {
  updateFloatingReportButtonVisibility();
  if (isAdminUser()) {
    const titleEl = document.querySelector('.catalog-header h2');
    if (titleEl) titleEl.textContent = 'Dashboard';
    if (elements.sortFilter) elements.sortFilter.hidden = true;
    if (elements.genreFilter) elements.genreFilter.hidden = true;
    renderAdminDashboard();
    return;
  }
  const titleEl = document.querySelector('.catalog-header h2');
  if (titleEl) titleEl.textContent = getBrowseHeading();
  if (elements.sortFilter) elements.sortFilter.hidden = false;
  if (elements.genreFilter) elements.genreFilter.hidden = false;
  const query = getSearchInputValue();
  const search = getActiveSearchQuery();
  populateGenreFilter();
  const baseFiltered = getFilteredLocalTitles();
  const filtered = sortTitles(baseFiltered);
  const renderKey = [
    query,
    search.mode,
    search.term,
    elements.typeFilter?.value || 'all',
    elements.genreFilter?.value || 'all',
    elements.sortFilter?.value || 'relevance',
    state.homeSectionView || '',
    state.selected?.catalogKey || ''
  ].join('|');
  if (state.lastCatalogRenderKey !== renderKey) {
    state.lastCatalogRenderKey = renderKey;
    resetCatalogViewport();
  }
  const shouldShowHome = query.length === 0 && !state.selected && (elements.typeFilter?.value || 'all') === 'all';

  if (shouldShowHome) {
    if (state.homeSectionView) {
      renderHomeSectionList(baseFiltered, state.homeSectionView);
      return;
    }
    renderHomeCatalog(baseFiltered);
    return;
  }

  if (state.isSearching && getSearchTermLength(search) >= 3 && searchSupportsRemote(search.mode)) {
    setCatalogCount(state.lastCountLabel || '0 títulos');
    elements.items.innerHTML = `<div class="loader-card"><span class="spinner"></span><strong>Buscando en fuentes externas</strong><p>Estamos reuniendo el listado completo antes de mostrar resultados.</p></div>`;
    return;
  }

  setCatalogCount(`${filtered.length} títulos`);
  elements.items.innerHTML = renderPaginatedLocalList(filtered);
  bindLocalCardEvents();

  if (filtered.length === 0 && search.term && getSearchTermLength(search) < 3 && searchSupportsRemote(search.mode)) {
    elements.items.innerHTML = '<div class="empty">Escribe al menos 3 letras para ampliar la búsqueda externa. Mientras tanto puedes seguir explorando el catálogo local.</div>';
  }
}

function renderAdminDashboard() {
  updateFloatingReportButtonVisibility();
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
    const userReportIssues = await workerListIssues({ state: 'all', labels: 'user-report', per_page: '100', sort: 'created', direction: 'desc' }).catch(() => []);
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
      const reportRows = (Array.isArray(userReportIssues) ? userReportIssues : [])
        .filter((issue) => !issue?.pull_request)
        .map((issue) => {
          const labels = Array.isArray(issue?.labels) ? issue.labels.map((row) => String(row?.name || '').trim().toLowerCase()) : [];
          const body = String(issue?.body || '');
          const title = extractBodyField(body, 'Title');
          const type = extractBodyField(body, 'Type');
          const imdbId = extractBodyField(body, 'IMDb');
          const tmdbId = extractBodyField(body, 'TMDB');
          const season = positiveInteger(extractBodyField(body, 'Season'), 0);
          const episode = positiveInteger(extractBodyField(body, 'Episode'), 0);
          const userEmailReported = extractBodyField(body, 'ReportedByEmail');
          const userNameReported = extractBodyField(body, 'ReportedByName');
          const category = extractBodyField(body, 'ProblemCategory') || 'other';
          const scope = extractBodyField(body, 'ReportScope') || (labels.includes(USER_REPORT_EPISODE_LABEL) ? 'episode' : labels.includes(USER_REPORT_TITLE_LABEL) ? 'title' : 'general');
          const createdAt = String(issue?.created_at || issue?.updated_at || '').trim();
          return {
            number: Number(issue?.number || 0),
            title,
            type,
            imdbId,
            tmdbId,
            season,
            episode,
            scope,
            category,
            state: String(issue?.state || '').trim().toLowerCase(),
            labels,
            createdAt,
            updatedAt: String(issue?.updated_at || createdAt).trim(),
            userEmail: String(userEmailReported || issue?.user?.login || '').trim().toLowerCase(),
            userName: String(userNameReported || '').trim(),
            htmlUrl: String(issue?.html_url || '').trim()
          };
        });
      const scopedReports = reportRows.filter((row) => toTs(row.createdAt) >= windowStart);
      const openReports = scopedReports.filter((row) => row.state === 'open');
      const reportUsers = new Map();
      const reportTitles = new Map();
      const reportEpisodes = new Map();
      for (const row of scopedReports) {
        const reportUserKey = String(row.userEmail || row.userName || 'unknown').trim().toLowerCase();
        const reportUserName = row.userName || row.userEmail || 'Usuario';
        const reportUserPrev = reportUsers.get(reportUserKey) || { key: reportUserKey, name: reportUserName, count: 0 };
        reportUserPrev.count += 1;
        reportUsers.set(reportUserKey, reportUserPrev);
        const contentId = String(row.imdbId || row.tmdbId || row.title || '').trim();
        const titleLabel = row.title || contentId || 'Sin título';
        if (contentId) {
          const titlePrev = reportTitles.get(contentId) || { id: contentId, name: titleLabel, count: 0, open: 0 };
          titlePrev.count += 1;
          if (row.state === 'open') titlePrev.open += 1;
          reportTitles.set(contentId, titlePrev);
          if (row.scope === 'episode' && row.season && row.episode) {
            const episodeKey = `${contentId}:s${row.season}e${row.episode}`;
            const episodePrev = reportEpisodes.get(episodeKey) || { key: episodeKey, name: `${titleLabel} T${row.season}E${row.episode}`, count: 0, open: 0 };
            episodePrev.count += 1;
            if (row.state === 'open') episodePrev.open += 1;
            reportEpisodes.set(episodeKey, episodePrev);
          }
        }
      }
      const topReportedTitles = [...reportTitles.values()].sort((a, b) => b.count - a.count).slice(0, 6);
      const topReportedEpisodes = [...reportEpisodes.values()].sort((a, b) => b.count - a.count).slice(0, 6);
      const topReportingUsers = [...reportUsers.values()].sort((a, b) => b.count - a.count).slice(0, 6);
      const contentHealth = analyticsContentRows
        .map((row) => {
          const contentId = String(row?.contentId || row?.imdbId || row?.tmdbId || '').trim();
          const reportInfo = reportTitles.get(contentId) || { count: 0, open: 0 };
          const starts = Number(row?.totalStarts || row?.totalEvents || 0);
          const completions = Number(row?.totalCompletions || 0);
          const rate = Number(row?.completionRate || 0);
          let status = 'sin validar';
          if (starts > 0 && reportInfo.count === 0 && rate >= 0.45) status = 'estable';
          else if (reportInfo.open > 0 || (starts >= 3 && completions === 0)) status = 'inestable';
          else if (reportInfo.count > 0 || (starts > 0 && rate < 0.45)) status = 'con reportes';
          return {
            id: contentId,
            title: String(row?.title || contentId).trim(),
            starts,
            completions,
            rate,
            reports: reportInfo.count,
            openReports: reportInfo.open,
            status
          };
        })
        .filter((row) => row.id)
        .sort((a, b) => {
          const severity = { inestable: 3, 'con reportes': 2, 'sin validar': 1, estable: 0 };
          return (severity[b.status] || 0) - (severity[a.status] || 0) || b.reports - a.reports || b.starts - a.starts;
        })
        .slice(0, 8);

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
            <article class="admin-kpi"><strong>${scopedReports.length}</strong><span>Reportes usuario (${days}d)</span></article>
            <article class="admin-kpi"><strong>${openReports.length}</strong><span>Reportes abiertos</span></article>
            <article class="admin-kpi"><strong>${completionRate}%</strong><span>Finalización global</span></article>
            <article class="admin-kpi"><strong>${movieCount}</strong><span>Películas seed</span></article>
            <article class="admin-kpi"><strong>${seriesCount}</strong><span>Series en seed</span></article>
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
              <div class="admin-chart">${topTitles.map((row) => `<div class="admin-bar"><span class="admin-bar-label">${escapeHtml(row.name)}</span><div class="admin-bar-track"><i style="width:${Math.max(8, Math.round((row.plays / maxTopPlays) * 100))}%"></i></div><small>${row.plays} reproducciones · ${row.completed} completados</small></div>`).join('') || '<p>Sin datos.</p>'}</div>
            </section>

            <section class="admin-panel">
              <h4>Salud de reproducción</h4>
              <div class="admin-chart">${contentHealth.map((row) => `<div class="admin-bar"><span class="admin-bar-label">${escapeHtml(row.title)}</span><small>${escapeHtml(`${row.status} · ${row.starts} intentos · ${Math.round(row.rate * 100)}% finalización · ${row.reports} reportes`)}</small></div>`).join('') || '<p>Sin datos.</p>'}</div>
            </section>

            <section class="admin-panel">
              <h4>Provisionamiento reciente</h4>
              <div class="admin-chart">${requests.slice(0, 8).map((row) => `<div class="admin-bar"><span class="admin-bar-label">${escapeHtml(`${row.role || 'role'} · ${row.email || 'n/a'}`)}</span><small>${escapeHtml(`${row.status || 'unknown'} · hace ${ago(row.requestedAt)}`)}</small></div>`).join('') || '<p>Sin solicitudes.</p>'}</div>
            </section>

            <section class="admin-panel">
              <h4>Títulos más reportados</h4>
              <div class="admin-chart">${topReportedTitles.map((row) => `<div class="admin-bar"><span class="admin-bar-label">${escapeHtml(row.name)}</span><small>${escapeHtml(`${row.count} reportes · ${row.open} abiertos`)}</small></div>`).join('') || '<p>Sin reportes.</p>'}</div>
            </section>

            <section class="admin-panel">
              <h4>Capítulos más reportados</h4>
              <div class="admin-chart">${topReportedEpisodes.map((row) => `<div class="admin-bar"><span class="admin-bar-label">${escapeHtml(row.name)}</span><small>${escapeHtml(`${row.count} reportes · ${row.open} abiertos`)}</small></div>`).join('') || '<p>Sin reportes de capítulos.</p>'}</div>
            </section>

            <section class="admin-panel">
              <h4>Usuarios que más reportan</h4>
              <div class="admin-chart">${topReportingUsers.map((row) => `<div class="admin-bar"><span class="admin-bar-label">${escapeHtml(row.name)}</span><small>${escapeHtml(`${row.count} reportes`)}</small></div>`).join('') || '<p>Sin reportes.</p>'}</div>
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
              <h4>Reportes recientes</h4>
              <div class="admin-chart">${scopedReports.slice(0, 8).map((row) => `<div class="admin-bar"><span class="admin-bar-label">${escapeHtml(`#${row.number} · ${row.title || row.scope}`)}</span><small>${escapeHtml(`${row.userEmail || row.userName || 'usuario'} · ${row.category} · ${row.state} · hace ${ago(row.createdAt)}`)}</small></div>`).join('') || '<p>Sin reportes recientes.</p>'}</div>
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
          await workerDispatchWorkflow('drain-watch-progress-queue.yml', 'main');
          if (msg) msg.textContent = 'Workflow de cola enviado correctamente.';
        } catch (error) {
          if (msg) msg.textContent = `No se pudo disparar cola: ${String(error?.message || error)}`;
        }
      });

      document.querySelector('#adminRunDeploy')?.addEventListener('click', async () => {
        const msg = document.querySelector('#adminRoleMsg');
        if (msg) msg.textContent = 'Disparando workflow de deploy...';
        try {
          await workerDispatchWorkflow('deploy-pages.yml', 'main');
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

function getUniqueRenderableTitles(items) {
  return dedupe(Array.isArray(items) ? items : [], { consolidateEquivalent: true });
}

// Cache HTML por sección en localStorage. Patrón stale-while-revalidate:
// próxima visita pinta cached al instante, luego re-computa en background y
// reemplaza si difiere. Cache es por usuario (cada user tiene sus propias
// secciones "Continuar viendo", "Me gusta", etc.).
function loadHomeSectionCache() {
  try {
    const raw = localStorage.getItem(SECTION_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.version !== 1) return null;
    const currentUser = String(getAuthUser()?.email || '').toLowerCase();
    if (String(data.userId || '').toLowerCase() !== currentUser) return null;
    return data;
  } catch { return null; }
}

function saveHomeSectionCache(sectionsHtmlMap) {
  try {
    const userId = String(getAuthUser()?.email || '').toLowerCase();
    if (!userId) return; // sin user no cacheamos
    if (!sectionsHtmlMap || Object.keys(sectionsHtmlMap).length === 0) return;
    localStorage.setItem(SECTION_CACHE_STORAGE_KEY, JSON.stringify({
      version: 1,
      userId,
      cachedAt: Date.now(),
      sections: sectionsHtmlMap
    }));
  } catch {
    // Quota exceeded o storage no disponible — best effort, sin fallback.
  }
}

// Helper para evitar double-bind cuando re-llamamos bindLocalCardEvents
// después de re-pintar sólo algunas secciones. Marca el elemento con un
// dataset bit; futuras llamadas skipean los ya marcados.
function bindOnce(el, marker, callback) {
  if (!el || el.dataset[marker]) return;
  el.dataset[marker] = '1';
  callback();
}

// Loader staged para primera visita (sin cache de secciones). Material-style:
// card centrada con icono, etiqueta de fase y barra de progreso. Aprovecha
// state.catalogHydration (que ya rastrea bootstrap/chunks/percent) y suma
// fases sintéticas pre/post hydration para que el user vea actividad
// continua incluso durante los ~50ms de compute final.
function getHomeBootstrapStage() {
  const hydration = state.catalogHydration;
  const catalog = loadLocalCatalog();
  if (!hydration?.active) {
    if (catalog.length === 0) return { label: 'Inicializando…', percent: 4 };
    return { label: 'Preparando tus secciones', percent: 96 };
  }
  if (hydration.phase === 'bootstrap') return { label: 'Cargando catálogo inicial', percent: 14 };
  if (hydration.phase === 'chunks-pending') return { label: 'Preparando carga progresiva', percent: 22 };
  if (hydration.phase === 'chunks') {
    const loaded = Number(hydration.loaded || 0);
    const total = Number(hydration.total || 0);
    if (total > 0) {
      const pct = Math.max(28, Math.min(93, Math.round(28 + (loaded / Math.max(total, 1)) * 65)));
      return { label: `Cargando catálogo · ${loaded.toLocaleString('es')}/${total.toLocaleString('es')} títulos`, percent: pct };
    }
    return { label: 'Cargando catálogo completo', percent: 45 };
  }
  return { label: 'Cargando catálogo', percent: 10 };
}

function buildHomeBootstrapLoaderHtml() {
  const stage = getHomeBootstrapStage();
  return `<section class="home-bootstrap-loading" role="status" aria-live="polite" aria-label="${escapeAttribute(`${stage.label}. ${stage.percent}%`)}">
    <div class="home-bootstrap-card">
      <div class="home-bootstrap-icon" aria-hidden="true">🎬</div>
      <h2>Preparando tu Devil TV</h2>
      <p class="home-bootstrap-stage" data-stage-label>${escapeHtml(stage.label)}</p>
      <div class="home-bootstrap-bar" aria-hidden="true"><span data-stage-progress style="width: ${stage.percent}%"></span></div>
      <span class="home-bootstrap-percent" data-stage-percent>${stage.percent}%</span>
    </div>
  </section>`;
}

function startHomeBootstrapLoaderTicker() {
  if (state.homeBootstrapLoaderTicker) return;
  state.homeBootstrapLoaderTicker = window.setInterval(() => {
    const card = elements.items.querySelector('.home-bootstrap-loading');
    if (!card) { stopHomeBootstrapLoaderTicker(); return; }
    const stage = getHomeBootstrapStage();
    const labelEl = card.querySelector('[data-stage-label]');
    const barEl = card.querySelector('[data-stage-progress]');
    const pctEl = card.querySelector('[data-stage-percent]');
    if (labelEl && labelEl.textContent !== stage.label) labelEl.textContent = stage.label;
    if (barEl) barEl.style.width = `${stage.percent}%`;
    if (pctEl) pctEl.textContent = `${stage.percent}%`;
  }, 300);
}

function stopHomeBootstrapLoaderTicker() {
  if (state.homeBootstrapLoaderTicker) {
    window.clearInterval(state.homeBootstrapLoaderTicker);
    state.homeBootstrapLoaderTicker = null;
  }
}

function renderHomeCatalog(baseFiltered) {
  // Setup sincrónico (rápido): contador + skeleton con "Cargando..." por
  // sección. Lo pesado (sortTitles, recommendationScore por sección) corre
  // async con yields entre cada para no bloquear el main thread.
  const watch = buildWatchInsights();
  cleanupWatchLaterFromCompleted(baseFiltered, watch);
  const prefs = loadTitlePrefs();
  const uniqueTitles = getUniqueRenderableTitles(baseFiltered);
  const discoveryLimit = isCompactViewport() ? 360 : 720;
  const discoveryTitles = uniqueTitles.slice(0, discoveryLimit);
  const previewLimit = isCompactViewport() ? 6 : 10;
  const providerSectionLimit = isCompactViewport() ? 4 : HOME_STREAMING_GROUPS.length;

  setCatalogCount(isCompactViewport() ? 'Explora por secciones' : `${baseFiltered.length} títulos`);

  // Cada sección expone su compute() lazy + minItems mínimo para mostrarse.
  const sectionDefs = [
    {
      key: 'continue', title: 'Continuar viendo', subtitle: 'Retoma donde lo dejaste',
      minItems: 1,
      compute: () => resolveContinueWatchingItems(uniqueTitles, watch)
    },
    {
      key: 'liked', title: 'Me gusta', subtitle: 'Tus favoritos guardados',
      minItems: 1,
      compute: () => uniqueTitles
        .filter((t) => Number(readTitlePreferenceValue(prefs.likes, t, 0) || 0) >= 1)
        .sort((a, b) => Number(readTitlePreferenceValue(prefs.likes, b, 0) || 0) - Number(readTitlePreferenceValue(prefs.likes, a, 0) || 0))
    },
    {
      key: 'watch_later', title: 'Ver más tarde', subtitle: 'Tu lista guardada',
      minItems: 1,
      compute: () => uniqueTitles
        .filter((t) => Boolean(readTitlePreferenceValue(prefs.watchLater, t, false)))
        .sort((a, b) => Number(readTitlePreferenceValue(prefs.watchLater, b, 0) || 0) - Number(readTitlePreferenceValue(prefs.watchLater, a, 0) || 0))
    },
    {
      key: 'movies_recommended', title: 'Películas para ti', subtitle: 'Sugerencias según lo que has visto',
      minItems: 1,
      compute: () => sortTitles(discoveryTitles.filter((t) => t.type === 'movie'), watch)
        .sort((a, b) => recommendationScore(b, watch) - recommendationScore(a, watch))
    },
    {
      key: 'series_recommended', title: 'Series para ti', subtitle: 'Sugerencias según lo que has visto',
      minItems: 1,
      compute: () => sortTitles(discoveryTitles.filter((t) => t.type === 'series'), watch)
        .sort((a, b) => recommendationScore(b, watch) - recommendationScore(a, watch))
    }
  ];

  for (const group of HOME_STREAMING_GROUPS.slice(0, providerSectionLimit)) {
    sectionDefs.push({
      key: `platform_${group.key}`,
      title: group.label,
      subtitle: `Disponible ahora en ${group.label}`,
      minItems: 4,
      compute: () => sortTitles(discoveryTitles.filter((t) => titleHasProvider(t, group.aliases || [group.key])), watch)
    });
  }

  sectionDefs.push({
    key: 'rewatch', title: 'Volver a ver', subtitle: 'Títulos que ya completaste',
    minItems: 1,
    compute: () => sortTitles(uniqueTitles.filter((t) => watch.completedIds.has(getTitleId(t))), watch)
      .sort((a, b) => (watch.scores[getTitleId(b)] || 0) - (watch.scores[getTitleId(a)] || 0))
  });

  // Render atómico:
  // 1. Si hay cache → pintar cache (instantáneo). Si NO hay cache → un único
  //    loader global centrado (no skeletons por sección — causaban flash
  //    cuando alguna sección se removía por minItems insuficientes).
  // 2. Si no hay datos en el catálogo todavía (discoveryTitles vacío),
  //    salir — la hydration de chunks dispará un render nuevo cuando llegue
  //    data real.
  // 3. Compute fresco corre en UNA pasada async (un solo yield al inicio).
  //    Todas las secciones se calculan off-DOM y se aplican al DOM en un
  //    solo bloque sincrónico al final. Sin paints intermedios.
  const alreadyPainted = elements.items.querySelector('[data-section-key], .home-bootstrap-loading') !== null;
  const cache = !alreadyPainted ? loadHomeSectionCache() : null;
  const cachedSections = cache?.sections || {};
  const hasCache = Object.keys(cachedSections).length > 0;

  if (!alreadyPainted) {
    if (hasCache) {
      const initialHtml = sectionDefs
        .filter((def) => cachedSections[def.key])
        .map((def) => buildSectionShellHtml(def, cachedSections[def.key]))
        .join('');
      elements.items.innerHTML = initialHtml;
      bindLocalCardEvents();
      bindHomeSectionEvents();
      bindHomeCarouselEvents();
    } else {
      elements.items.innerHTML = buildHomeBootstrapLoaderHtml();
      startHomeBootstrapLoaderTicker();
    }
  }

  // Sin data todavía: dejar el loader/cache visible. El próximo render con
  // datos reales (post-hydration) se encarga del compute.
  if (discoveryTitles.length === 0) return;

  const myToken = ++homeRenderToken;

  (async () => {
    // Un único yield para liberar el main thread (evita bloquear el primer
    // paint). Después de esto, todo el trabajo va en una sola pasada.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (myToken !== homeRenderToken) return;

    // Compute OFF-DOM: calculamos el HTML de todas las secciones sin tocar
    // elements.items. Recién al final aplicamos cambios.
    const eagerState = { taken: false };
    const computed = []; // [{ def, carouselHtml | null }]
    const computeLog = {};
    for (const def of sectionDefs) {
      let items;
      try { items = def.compute(); } catch { items = []; }
      computeLog[def.key] = items.length;
      if (items.length < def.minItems) {
        computed.push({ def, carouselHtml: null });
        continue;
      }
      const eagerCount = eagerState.taken ? 0 : 2;
      eagerState.taken = true;
      computed.push({ def, carouselHtml: buildSectionCarouselHtml(def, items, previewLimit, eagerCount) });
    }
    if (myToken !== homeRenderToken) return;
    dtvLog('render', 'renderHomeCatalog sections computed', {
      baseFiltered: baseFiltered.length,
      discoveryTitles: discoveryTitles.length,
      continueIds: watch.continueIds.size,
      completedIds: watch.completedIds.size,
      sections: computeLog
    });

    const freshSectionsHtml = {};
    let finalHtml = '';
    for (const { def, carouselHtml } of computed) {
      if (!carouselHtml) continue;
      freshSectionsHtml[def.key] = carouselHtml;
      finalHtml += buildSectionShellHtml(def, carouselHtml);
    }

    // Fallback: nada cumplió minItems pero el catálogo tiene títulos.
    if (!finalHtml) {
      const latestItems = sortTitles(discoveryTitles, watch).slice(0, 24);
      if (latestItems.length) {
        finalHtml = `
          <section class="home-section" data-section-key="latest">
            <div class="home-section-head">
              <h3>Catálogo destacado</h3>
              <span>Una selección para comenzar</span>
            </div>
            <div class="home-carousel" data-home-carousel="latest">
              <button class="home-nav home-nav-prev" type="button" data-home-prev aria-label="Anterior">‹</button>
              <div class="home-viewport">
                <div class="home-track">${renderLocalCards(latestItems.slice(0, previewLimit), { eagerCount: 2 })}</div>
              </div>
              <button class="home-nav home-nav-next" type="button" data-home-next aria-label="Siguiente">›</button>
            </div>
          </section>
        `;
      } else {
        // Catálogo realmente vacío — preservar lo que sea que esté pintado.
        return;
      }
    }

    // Aplicar al DOM. Si ya está pintada cache, hacemos per-section diff
    // (solo reemplazamos secciones que cambiaron) para evitar reflow innecesario
    // de imágenes que ya cargaron. Si no había nada pintado (loader o vacío),
    // un solo innerHTML = finalHtml.
    const bootstrapLoader = elements.items.querySelector('.home-bootstrap-loading');
    if (bootstrapLoader || elements.items.children.length === 0) {
      stopHomeBootstrapLoaderTicker();
      elements.items.innerHTML = finalHtml;
      bindLocalCardEvents();
      bindHomeSectionEvents();
      bindHomeCarouselEvents();
    } else {
      let anyDomChanged = false;
      // 1. Remover secciones que ya no aplican.
      const presentKeys = new Set(Object.keys(freshSectionsHtml));
      elements.items.querySelectorAll('[data-section-key]').forEach((el) => {
        const key = el.getAttribute('data-section-key');
        if (key && !presentKeys.has(key) && key !== 'latest') {
          el.remove();
          anyDomChanged = true;
        }
      });
      // 2. Para cada sección presente, comparar contra cache. Solo reemplazar
      //    si difiere. Insertar en posición correcta si no existe.
      for (const { def, carouselHtml } of computed) {
        if (!carouselHtml) continue;
        const existingEl = elements.items.querySelector(`[data-section-key="${def.key}"]`);
        if (!existingEl) {
          const fullSectionHtml = buildSectionShellHtml(def, carouselHtml);
          const myIndex = sectionDefs.indexOf(def);
          let inserted = false;
          for (let i = myIndex + 1; i < sectionDefs.length; i++) {
            const nextEl = elements.items.querySelector(`[data-section-key="${sectionDefs[i].key}"]`);
            if (nextEl) { nextEl.insertAdjacentHTML('beforebegin', fullSectionHtml); inserted = true; break; }
          }
          if (!inserted) elements.items.insertAdjacentHTML('beforeend', fullSectionHtml);
          anyDomChanged = true;
          continue;
        }
        const cachedCarousel = String(cachedSections[def.key] || '').trim();
        if (cachedCarousel && cachedCarousel === carouselHtml.trim()) continue; // Identical to cache — DOM ya está OK.
        const target = existingEl.querySelector('.home-carousel');
        if (target) target.outerHTML = carouselHtml;
        else existingEl.insertAdjacentHTML('beforeend', carouselHtml);
        anyDomChanged = true;
      }
      if (anyDomChanged) {
        bindLocalCardEvents();
        bindHomeSectionEvents();
        bindHomeCarouselEvents();
      }
    }

    saveHomeSectionCache(freshSectionsHtml);
  })();
}

function buildSectionShellHtml(def, innerHtml) {
  return `
    <section class="home-section" data-section-key="${escapeAttribute(def.key)}">
      <div class="home-section-head">
        <h3>${escapeHtml(def.title)}</h3>
        <span>${escapeHtml(def.subtitle)}</span>
      </div>
      ${innerHtml}
    </section>
  `;
}

function buildSectionCarouselHtml(def, items, previewLimit, eagerCount) {
  const preview = items.slice(0, previewLimit);
  const showMore = items.length > preview.length;
  const allowMissingPoster = def.key === 'continue';
  const cards = `${preview.length ? renderLocalCards(preview, { eagerCount, allowMissingPoster }) : '<div class="empty">Sin resultados por ahora.</div>'}${showMore ? `<article class="home-more" data-home-seeall="${escapeAttribute(def.key)}"><div class="home-more-icon" aria-hidden="true">→</div><strong>Explorar todo</strong><span>Ver el listado completo</span></article>` : ''}`;
  return `
    <div class="home-carousel" data-home-carousel="${escapeAttribute(def.key)}">
      <button class="home-nav home-nav-prev" type="button" data-home-prev aria-label="Anterior">‹</button>
      <div class="home-viewport">
        <div class="home-track">
          ${cards}
        </div>
      </div>
      <button class="home-nav home-nav-next" type="button" data-home-next aria-label="Siguiente">›</button>
    </div>
  `;
}


function renderHomeSectionList(baseFiltered, sectionKey) {
  cleanupWatchLaterFromCompleted(baseFiltered);
  const prefs = loadTitlePrefs();
  const watch = buildWatchInsights();
  const uniqueTitles = getUniqueRenderableTitles(baseFiltered);
  let title = 'Listado';
  let items = [];
  if (sectionKey === 'watch_later') {
    title = 'Ver más tarde';
    items = uniqueTitles
      .filter((t) => Boolean(readTitlePreferenceValue(prefs.watchLater, t, false)))
      .sort((a, b) => Number(readTitlePreferenceValue(prefs.watchLater, b, 0) || 0) - Number(readTitlePreferenceValue(prefs.watchLater, a, 0) || 0));
  } else if (sectionKey === 'liked') {
    title = 'Me gusta';
    items = uniqueTitles
      .filter((t) => Number(readTitlePreferenceValue(prefs.likes, t, 0) || 0) >= 1)
      .sort((a, b) => Number(readTitlePreferenceValue(prefs.likes, b, 0) || 0) - Number(readTitlePreferenceValue(prefs.likes, a, 0) || 0));
  } else if (sectionKey === 'continue') {
    title = 'Continuar viendo';
    items = resolveContinueWatchingItems(uniqueTitles, watch);
  } else if (sectionKey === 'rewatch') {
    title = 'Volver a ver';
    items = sortTitles(uniqueTitles.filter((t) => watch.completedIds.has(getTitleId(t)))).sort((a, b) => (watch.scores[getTitleId(b)] || 0) - (watch.scores[getTitleId(a)] || 0));
  } else if (sectionKey === 'movies_recommended') {
    title = 'Películas para ti';
    items = sortTitles(uniqueTitles.filter((t) => t.type === 'movie')).sort((a, b) => recommendationScore(b, watch) - recommendationScore(a, watch));
  } else if (sectionKey === 'series_recommended') {
    title = 'Series para ti';
    items = sortTitles(uniqueTitles.filter((t) => t.type === 'series')).sort((a, b) => recommendationScore(b, watch) - recommendationScore(a, watch));
  } else if (sectionKey === 'latest') {
    title = 'Catálogo destacado';
    items = sortTitles(uniqueTitles).slice(0, 24);
  } else if (sectionKey.startsWith('platform_')) {
    const match = sectionKey.match(/^platform_([a-z0-9]+)$/);
    if (match) {
      const providerKey = match[1];
      const group = HOME_STREAMING_GROUPS.find((entry) => entry.key === providerKey);
      const providerLabel = group?.label || providerKey;
      title = providerLabel;
      items = sortTitles(baseFiltered.filter((t) => titleHasProvider(t, group?.aliases || [providerKey])));
    }
  }
  setCatalogCount(`${items.length} títulos`);
  elements.items.innerHTML = `
    <section class="home-section-list">
      <div class="home-section-list-head">
        <h3>${escapeHtml(title)}</h3>
        <button type="button" id="homeBack">Volver al inicio</button>
      </div>
      ${renderPaginatedLocalList(items, { allowMissingPoster: sectionKey === 'continue' })}
    </section>`;
  bindLocalCardEvents();
  document.querySelector('#homeBack')?.addEventListener('click', () => {
    state.homeSectionView = null;
    resetCatalogViewport();
    renderCatalog();
  });
}

function bindHomeSectionEvents() {
  elements.items.querySelectorAll('[data-home-seeall]').forEach((entry) => {
    bindOnce(entry, 'boundSeeall', () => {
      entry.addEventListener('click', () => {
        state.homeSectionView = entry.dataset.homeSeeall || null;
        resetCatalogViewport();
        renderCatalog();
      });
    });
  });
}

function renderLoadMoreCard(remaining) {
  if (remaining <= 0) return '';
  return `<article class="home-more" data-catalog-more="1"><div class="home-more-icon" aria-hidden="true">+</div><strong>Cargar más</strong><span>Quedan ${remaining} títulos por mostrar</span></article>`;
}

function renderPaginatedLocalList(items, options = {}) {
  const safeItems = Array.isArray(items) ? items : [];
  const visible = safeItems.slice(0, state.catalogVisibleCount);
  const remaining = Math.max(0, safeItems.length - visible.length);
  if (!visible.length) return '<div class="empty">Sin resultados por ahora.</div>';
  return `<div class="items catalog-results-grid">${renderLocalCards(visible, { eagerCount: 8, allowMissingPoster: Boolean(options.allowMissingPoster) })}${renderLoadMoreCard(remaining)}</div>`;
}

function bindHomeCarouselEvents() {
  const carousels = elements.items.querySelectorAll('[data-home-carousel]');
  carousels.forEach((carousel) => {
    if (carousel.dataset.boundCarousel) return; // ya bindeado, skip
    carousel.dataset.boundCarousel = '1';
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
      if (event.pointerType === 'touch') {
        try {
          viewport.setPointerCapture(event.pointerId);
          dragState.captured = true;
        } catch {}
      }
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
    viewport.addEventListener('lostpointercapture', endDrag);
    viewport.addEventListener('pointerleave', endDrag);

    window.addEventListener('resize', apply);
    apply();
  });
}

function bindEpisodeCarouselEvents() {
  const carousels = elements.detail?.querySelectorAll('[data-episodes-carousel]') || [];
  carousels.forEach((carousel) => {
    const viewport = carousel.querySelector('.episodes-viewport');
    const track = carousel.querySelector('.episodes-track');
    const prevBtn = carousel.querySelector('[data-episodes-prev]');
    const nextBtn = carousel.querySelector('[data-episodes-next]');
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
      if (wasDragged) carousel.dataset.lastDragAt = String(Date.now());
      apply();
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
        if (Math.abs(deltaX) < 8) return;
        dragState.moved = true;
      }
      dragState.currentTranslate = dragState.baseTranslate + deltaX;
      const { step, maxPage } = metrics();
      const minTranslate = -(maxPage * step);
      dragState.currentTranslate = Math.max(minTranslate - 36, Math.min(36, dragState.currentTranslate));
      track.style.transform = `translateX(${dragState.currentTranslate}px)`;
    };

    bindTap(prevBtn, () => {
      page -= 1;
      apply();
    });
    bindTap(nextBtn, () => {
      page += 1;
      apply();
    });

    viewport.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const interactiveTarget = event.target instanceof Element
        ? event.target.closest('button, a, input, textarea, select')
        : null;
      if (interactiveTarget) return;
      const { step } = metrics();
      dragState = {
        startX: event.clientX,
        startY: event.clientY,
        baseTranslate: -(page * step),
        currentTranslate: -(page * step),
        moved: false
      };
      carousel.classList.add('is-dragging');
      try {
        viewport.setPointerCapture?.(event.pointerId);
      } catch {}
    });
    viewport.addEventListener('pointermove', (event) => updateDrag(event.clientX, event.clientY));
    viewport.addEventListener('pointerup', finishDrag);
    viewport.addEventListener('pointercancel', finishDrag);
    viewport.addEventListener('lostpointercapture', finishDrag);
    window.addEventListener('resize', apply);
    apply();
  });
}

function getFilteredLocalTitles() {
  const search = getActiveSearchQuery();
  const selectedGenre = (elements.genreFilter?.value || 'all').toLowerCase();
  const titles = loadLocalCatalog();
  const cacheKey = [
    titles.length,
    search.mode,
    search.normalizedTerm,
    selectedGenre,
    elements.typeFilter?.value || 'all'
  ].join('|');
  if (state.filteredCatalogCacheKey === cacheKey && Array.isArray(state.filteredCatalogCache)) {
    return state.filteredCatalogCache;
  }
  const filtered = titles.filter((title) => {
    if (title.type === 'episode') return false;
    if (!hasPosterAsset(title)) return false;
    const genres = (title.metadata?.genres || title.categories || []).map((g) => String(g).toLowerCase());
    const genreMatches = selectedGenre === 'all' || genres.some((g) => g === selectedGenre);
    return genreMatches && matchesSearchFilters(title, search);
  });
  state.filteredCatalogCacheKey = cacheKey;
  state.filteredCatalogCache = filtered;
  return filtered;
}

function populateGenreFilter() {
  const select = elements.genreFilter;
  if (!select) return;
  const current = select.value || 'all';
  const titles = loadLocalCatalog();
  const cacheKey = `${titles.length}|${localStorage.getItem('mep_seed_version') || '0'}`;
  if (state.genreFilterCacheKey === cacheKey && state.genreFilterOptionsHtml) {
    select.innerHTML = state.genreFilterOptionsHtml;
    const nextCached = [...select.options].some((opt) => opt.value === current) ? current : 'all';
    select.value = nextCached;
    return;
  }
  const genres = new Set();
  for (const title of titles) {
    if (!hasPosterAsset(title)) continue;
    const list = title.metadata?.genres || title.categories || [];
    for (const genre of list) {
      const value = String(genre || '').trim();
      if (value) genres.add(value);
    }
  }
  const sorted = [...genres].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
  const optionsHtml = `<option value="all">Todos los géneros</option>${sorted.map((g) => `<option value="${escapeAttribute(g.toLowerCase())}">${escapeHtml(g)}</option>`).join('')}`;
  state.genreFilterCacheKey = cacheKey;
  state.genreFilterOptionsHtml = optionsHtml;
  select.innerHTML = optionsHtml;
  const next = [...select.options].some((opt) => opt.value === current) ? current : 'all';
  select.value = next;
}

// Placeholder visual cuando la entry no tiene poster (típico: Continuar viendo
// con entries huérfanas del sync remoto). Lleva título + icono para que el
// card no se vea vacío, y un data-poster-pending para que tryRepairPendingPosters
// dispare el repair async sin esperar al error del <img>.
function renderPosterPlaceholder(title) {
  const titleText = String(title?.title || '').trim();
  const initial = (titleText[0] || '?').toUpperCase();
  const imdb = String(title?.imdbId || '').trim();
  const tmdb = String(title?.tmdbId || '').trim();
  const pendingAttr = (imdb || tmdb) ? `data-poster-pending="${escapeAttribute(imdb || tmdb)}"` : '';
  return `<div class="item-poster placeholder" ${pendingAttr}>
    <span class="placeholder-initial" aria-hidden="true">${escapeHtml(initial)}</span>
    <span class="placeholder-title">${escapeHtml(titleText || 'Sin título')}</span>
  </div>`;
}

function renderLocalCards(titles, options = {}) {
  const isAdmin = isAdminUser();
  const prefs = loadTitlePrefs();
  const eagerCount = Math.max(0, Number(options.eagerCount || 0));
  // allowMissingPoster: en "Continuar viendo" mostramos entries cuyo poster
  // aún no llegó (típicamente: title visto en otro device + sync recién
  // mergeado + catalog seed sin enriquecer todavía). El HTML ya tiene
  // placeholder; lo único que falta es no filtrarlas afuera acá.
  const allowMissingPoster = Boolean(options.allowMissingPoster);
  const filtered = allowMissingPoster ? titles : titles.filter((title) => hasPosterAsset(title));
  return filtered.map((title, index) => {
    const active = state.selected?.catalogKey === title.catalogKey ? ' active' : '';
    const poster = getCardPosterUrl(title.posterUrl || title.metadata?.posterUrl || '');
    const eagerAttrs = index < eagerCount ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
    const unavailable = isAuthenticated() && title.playable === false ? '<span class="pill pill-warn">No disponible</span>' : '';
    const typeLabel = title.type === 'series' ? 'Serie' : title.type === 'movie' ? 'Película' : String(title.type || '');
    const startYear = title.year ?? '';
    const endYear = title.type === 'series' ? (title.metadata?.endYear ?? '') : '';
    const yearLabel = endYear && startYear ? `${startYear}-${endYear}` : (startYear || '');
    const canPlay = !isAdmin && isAuthenticated() && title.playable !== false && (title.type === 'movie' || title.type === 'series');
    const playOverlay = canPlay ? `<button class="item-play" type="button" aria-label="Reproducir ${escapeAttribute(title.title || 'título')}" data-play-key="${escapeHtml(title.catalogKey)}"><span class="item-play-icon" aria-hidden="true">▶</span></button>` : '';
    const posterEl = poster
      ? `<img class="item-poster" src="${escapeAttribute(poster)}" alt="${escapeAttribute(`Póster de ${title.title || 'título'}`)}" ${eagerAttrs} referrerpolicy="no-referrer" />`
      : renderPosterPlaceholder(title);
    return `<article class="item${active}" data-key="${escapeHtml(title.catalogKey)}">
      ${posterEl}
      ${playOverlay}
      <div><strong>${escapeHtml(title.title)}</strong>${getCardQuickActions(title, prefs)}${unavailable}<span class="meta">${escapeHtml([typeLabel, yearLabel].filter(Boolean).join(' | '))}</span></div>
    </article>`;
  }).join('');
}

function getUnifiedTitlePool() {
  const pool = [...loadLocalCatalog(), ...(Array.isArray(state.remoteResults) ? state.remoteResults : [])];
  if (state.selected) pool.push(state.selected);
  return dedupe(pool, { consolidateEquivalent: true });
}

function suspendSearchUiForSelection() {
  state.searchIntentId += 1;
  state.isSearching = false;
  clearTimeout(state.remoteSearchTimer);
  clearTimeout(state.searchCommitTimer);
}

function findTitleInLoadedCollections(predicate) {
  const local = loadLocalCatalog();
  for (const entry of local) {
    if (predicate(entry)) return entry;
  }
  const remote = Array.isArray(state.remoteResults) ? state.remoteResults : [];
  for (const entry of remote) {
    if (predicate(entry)) return entry;
  }
  if (state.selected && predicate(state.selected)) return state.selected;
  return null;
}

function resolveTitleByCatalogKey(key) {
  const target = String(key || '').trim();
  if (!target) return null;
  return findTitleInLoadedCollections((entry) => String(entry?.catalogKey || '').trim() === target);
}

function resolveTitleForInteraction(key) {
  const target = String(key || '').trim();
  if (!target) return null;
  return findTitleInLoadedCollections((entry) => (
    String(entry?.catalogKey || '').trim() === target ||
    String(entry?.imdbId || '').trim() === target ||
    String(entry?.tmdbId || '').trim() === target ||
    String(getTitleId(entry) || '').trim() === target
  ));
}

function resolveTitleByPreferenceId(prefId) {
  const target = String(prefId || '').trim();
  if (!target) return null;
  return findTitleInLoadedCollections((entry) => String(getTitleId(entry) || '').trim() === target);
}

function returnToCatalogHome() {
  prepareManualRouteTransition();
  clearSelection();
  document.body.classList.remove('detail-active');
  renderDetail();
  syncRoute({ force: true });
}

function bindLocalCardEvents() {
  bindPosterFallbacks(elements.items);
  elements.items.querySelectorAll('[data-catalog-more="1"]').forEach((entry) => {
    bindTap(entry, (event) => {
      event.preventDefault();
      state.catalogVisibleCount += CATALOG_PAGE_SIZE;
      const search = getActiveSearchQuery();
      if (state.remoteResults.length > 0 && getSearchTermLength(search) >= 3 && searchSupportsRemote(search.mode)) {
        renderRemoteResults(getSearchInputValue());
        return;
      }
      renderCatalog();
    });
  });
  bindQuickActionButtons(elements.items);

  elements.items.querySelectorAll('.item-play').forEach((btn) => {
    bindTap(btn, async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const key = btn.dataset.playKey;
      if (!key) return;
      const selected = resolveTitleForInteraction(key);
      if (!selected) return;
      prepareManualRouteTransition();
      suspendSearchUiForSelection();
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
    bindTap(item, async () => {
      if (isAdminUser()) return;
      const homeCarousel = item.closest('[data-home-carousel]');
      if (homeCarousel) {
        const lastDragAt = homeCarouselLastDragAt.get(homeCarousel) || 0;
        if (Date.now() - lastDragAt < 350) return;
      }
      prepareManualRouteTransition();
      state.selected = resolveTitleForInteraction(item.dataset.key);
      if (!state.selected) return;
      suspendSearchUiForSelection();
      if (isAuthenticated() && state.selected) {
        const selectedForSeedSync = state.selected;
        scheduleDelayedIdleTask(() => queueCatalogSeedSyncForTitle(selectedForSeedSync), 1200, 1000);
      }
      state.seriesEpisodes = null;
      state.seriesEpisodesLoading = isAuthenticated() && isSeriesLike(state.selected);
      state.hydratedProgressId = '';
      renderDetail();
      if (isAuthenticated() && isSeriesLike(state.selected)) loadSeriesEpisodes().then(renderDetail);
      syncRoute({ force: true });
      hydrateSelectedFromTmdb().then(() => renderDetail({ skipHydratePlayback: true }));
    });
  });
}

function bindQuickActionButtons(root = document) {
  root.querySelectorAll?.('.item-quick-btn').forEach((btn) => {
    const stopCardNavigation = (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
    };
    btn.addEventListener('pointerdown', stopCardNavigation, { passive: false });
    bindTap(btn, (event) => {
      stopCardNavigation(event);
      const action = String(btn.dataset.quickAction || '').trim();
      const prefId = String(btn.dataset.prefId || '').trim();
      const card = btn.closest('.item');
      const key = String(card?.dataset?.key || '').trim();
      if (!action || (!prefId && !key)) return;
      let title = null;
      if (key) title = resolveTitleByCatalogKey(key);
      if (!title && prefId) title = resolveTitleByPreferenceId(prefId);
      if (!title && state.selected && String(getTitleId(state.selected) || '').trim() === prefId) title = state.selected;
      if (!title) return;
      setTitlePreference(title, action);
      const id = String(getTitleId(title) || '').trim();
      updateQuickActionButtons(id);
      const prefs = loadTitlePrefs();
      if (action === 'later' && state.homeSectionView === 'watch_later' && card && !Boolean(readTitlePreferenceValue(prefs.watchLater, title, false))) {
        card.remove();
      }
      if (action === 'like' && state.homeSectionView === 'liked' && card && Number(readTitlePreferenceValue(prefs.likes, title, 0) || 0) < 1) {
        card.remove();
      }
    });
    btn.addEventListener('click', stopCardNavigation, { passive: false });
  });
}

function bindPosterFallbacks(root = document) {
  root.querySelectorAll?.('img.item-poster').forEach((img) => {
    img.addEventListener('error', async () => {
      if (img.dataset.posterFallbackApplied === '1') return;
      img.dataset.posterFallbackApplied = '1';
      const card = img.closest('.item');
      const key = String(card?.dataset?.key || '').trim();
      let title = key ? resolveTitleByCatalogKey(key) : null;
      if (!title && state.selected && String(state.selected.catalogKey || '').trim() === key) title = state.selected;
      const repaired = title ? await ensurePosterForTitle(title, { registerSeed: true }).catch(() => '') : '';
      if (repaired) {
        img.src = repaired;
        img.dataset.posterFallbackApplied = '0';
        return;
      }
      const placeholder = document.createElement('div');
      placeholder.className = 'item-poster placeholder';
      placeholder.innerHTML = title ? renderPosterPlaceholderInner(title) : '';
      img.replaceWith(placeholder);
    });
  });
  tryRepairPendingPosters(root);
}

// Para placeholders que ya nacieron sin poster (Continuar viendo con entries
// huérfanas o m.media-amazon URLs que ya marcamos como rotas): dispara repair
// async sin esperar al `error` event de un <img> que ni siquiera existe.
function renderPosterPlaceholderInner(title) {
  const titleText = String(title?.title || '').trim();
  const initial = (titleText[0] || '?').toUpperCase();
  return `<span class="placeholder-initial" aria-hidden="true">${escapeHtml(initial)}</span>
    <span class="placeholder-title">${escapeHtml(titleText || 'Sin título')}</span>`;
}

function tryRepairPendingPosters(root = document) {
  const nodes = root.querySelectorAll?.('.item-poster.placeholder[data-poster-pending]') || [];
  nodes.forEach(async (node) => {
    if (node.dataset.posterRepairTried === '1') return;
    node.dataset.posterRepairTried = '1';
    const card = node.closest('.item');
    const key = String(card?.dataset?.key || '').trim();
    const title = key ? resolveTitleByCatalogKey(key) : null;
    if (!title) return;
    const repaired = await ensurePosterForTitle(title, { registerSeed: true }).catch(() => '');
    if (!repaired) return;
    // Reemplaza el placeholder por un <img> real ahora que tenemos poster.
    const img = document.createElement('img');
    img.className = 'item-poster';
    img.src = repaired;
    img.alt = `Póster de ${title.title || 'título'}`;
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.loading = 'lazy';
    node.replaceWith(img);
    // Re-bind el error fallback sobre el nuevo <img>.
    img.addEventListener('error', async () => {
      if (img.dataset.posterFallbackApplied === '1') return;
      img.dataset.posterFallbackApplied = '1';
      const placeholder = document.createElement('div');
      placeholder.className = 'item-poster placeholder';
      placeholder.innerHTML = renderPosterPlaceholderInner(title);
      img.replaceWith(placeholder);
    });
  });
}

function scheduleRemoteSearch() {
  clearTimeout(state.remoteSearchTimer);
  const intentId = state.searchIntentId;
  const search = getActiveSearchQuery();
  const query = search.term;
  state.searchingTerm = getSearchInputValue();
  if (getSearchTermLength(search) < 3 || !searchSupportsRemote(search.mode)) {
    state.isSearching = false;
    renderCatalog();
    return;
  }
  if (!isAuthenticated()) return;
  const remoteKey = [
    search.mode,
    search.normalizedTerm,
    elements.typeFilter.value || 'all'
  ].join('|');
  state.isSearching = true;
  state.remoteSearchTimer = setTimeout(async () => {
    if (intentId !== state.searchIntentId) return;
    if (state.lastRemoteQuery === remoteKey) return;
    state.lastRemoteQuery = remoteKey;
    await searchRemoteCatalog(search, intentId);
    state.isSearching = false;
    syncRoute();
  }, 700);
}

function scheduleSearchCommit() {
  clearTimeout(state.searchCommitTimer);
  const intentId = state.searchIntentId;
  state.searchCommitTimer = setTimeout(async () => {
    if (intentId !== state.searchIntentId) return;
    const search = getActiveSearchQuery();
    state.searchingTerm = getSearchInputValue();
    state.lastRemoteQuery = '';
    syncRoute();
    if (!isAuthenticated()) {
      state.isSearching = false;
      renderCatalog();
      return;
    }
    if (getSearchTermLength(search) < 3 || !searchSupportsRemote(search.mode)) {
      state.isSearching = false;
      renderCatalog();
      return;
    }
    state.isSearching = true;
    renderCatalog();
    await searchRemoteCatalog(search, intentId);
  }, 1200);
}

async function searchRemoteCatalog(searchInput, intentId = state.searchIntentId) {
  const search = typeof searchInput === 'string' ? parseSearchQuery(searchInput) : (searchInput || getActiveSearchQuery());
  const query = search.term;
  try {
    const results = await searchViaListingsAndImdb(search, getEffectiveTypeFilter(search));
    if (intentId !== state.searchIntentId) return;
    for (const item of results) {
      if (sanitizePosterUrl(item.posterUrl || item.metadata?.posterUrl || '')) continue;
      await ensurePosterForTitle(item, { registerSeed: true }).catch(() => {});
    }
    if (intentId !== state.searchIntentId) return;
    const withPlayable = filterTitlesWithPoster(results.map((item) => ({ ...item, playable: true }))).filter((item) => matchesSearchFilters(item, search));
    state.remoteResults = sortByRelevance(dedupe(withPlayable), query).map(normalizeSelection);
    for (const remoteTitle of state.remoteResults) queueCatalogSeedSyncForTitle(remoteTitle);
    cacheSearchResults(state.remoteResults);
    if (intentId !== state.searchIntentId) return;
    renderRemoteResults(getSearchInputValue());
  } catch (error) {
    if (intentId !== state.searchIntentId) return;
    // La búsqueda remota falló. Notificamos con toast diferenciado (NO con
    // un "sin resultados" que el user pueda confundir con catálogo vacío)
    // y re-renderizamos el catálogo local — si hay coincidencias locales,
    // el user las sigue viendo aunque la API remota esté caída.
    dtvLog('error', 'remote search failed', { query, message: error?.message });
    showToast({
      icon: 'error',
      title: 'La búsqueda en línea falló. Mostramos solo el catálogo local.',
      timer: 4500
    });
    state.remoteResults = [];
    renderCatalog();
  } finally {
    if (intentId === state.searchIntentId) {
      state.isSearching = false;
      setCatalogCount(state.lastCountLabel || '0 títulos');
    }
  }
}

function renderRemoteResults(query) {
  cleanupWatchLaterFromCompleted();
  const localResults = getFilteredLocalTitles();
  const search = typeof query === 'string' ? parseSearchQuery(query) : getActiveSearchQuery();
  const rankingQuery = search.mode === 'text' ? query : search.term;
  const labelQuery = typeof query === 'string' ? query : getSearchInputValue();
  const merged = sortResultEntries(mergeAndRankResults(localResults, state.remoteResults, rankingQuery));
  setCatalogCount(`${merged.length} coincidencias para "${labelQuery}"`);
  // Show every merged credit at once — no "Cargar más" gating on actor/director
  // searches. The hard slice that originally capped at 36 is gone, and the
  // local catalog pagination must not hide the long tail behind a click.
  if (state.catalogVisibleCount < merged.length) {
    state.catalogVisibleCount = merged.length;
  }
  elements.items.innerHTML = merged.length
    ? renderPaginatedLocalList(merged.map((entry) => entry.title))
    : '<div class="empty">No encontramos resultados para esa búsqueda.</div>';
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

function sortTitles(titles, watchOverride = null) {
  const mode = getSortMode();
  const items = [...titles];
  const watch = watchOverride || buildWatchInsights();
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

// Resuelve los items de "Continuar viendo" con triple fallback:
//   (1) entries presentes en uniqueTitles (catálogo filtrado, con poster).
//   (2) entries en el catálogo local completo (incluye las sin poster).
//   (3) entries que solo existen en el progress remoto/lastWatch (ej. visto
//       en otro device antes de que el seed se enriquezca acá).
// Sin esto, un título visto en sesión A nunca aparece en sesión B si el
// catálogo seed de B no lo tiene aún. Los del fallback (2) y (3) llevan
// poster placeholder (lo maneja renderLocalCards con allowMissingPoster).
function resolveContinueWatchingItems(uniqueTitles, watch) {
  const ids = watch?.continueIds ? [...watch.continueIds] : [];
  if (ids.length === 0) return [];
  const fullCatalog = loadLocalCatalog();
  const byCatalogId = new Map();
  for (const t of fullCatalog) {
    const tid = getTitleId(t);
    if (tid) byCatalogId.set(tid, t);
    const imdb = String(t?.imdbId || '').trim();
    const tmdb = String(t?.tmdbId || '').trim();
    if (imdb) byCatalogId.set(imdb, t);
    if (tmdb) byCatalogId.set(tmdb, t);
  }
  const seen = new Set();
  const out = [];
  // Resolución por id (cubre fallbacks 1 y 2).
  for (const id of ids) {
    if (seen.has(id)) continue;
    const inUnique = uniqueTitles.find((t) => getTitleId(t) === id);
    const entry = inUnique || byCatalogId.get(id);
    if (entry) {
      const key = entry.catalogKey || getTitleId(entry) || id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  // Fallback 3: ids que ni siquiera están en el catálogo local. Lo armamos
  // desde lastWatch + synced.progress. Mejor un placeholder que invisible.
  const user = getAuthUser();
  const synced = user?.email ? loadSyncedWatchProgress(user.email) : null;
  const remoteProgress = synced?.progress && typeof synced.progress === 'object' ? synced.progress : {};
  for (const id of ids) {
    const existsInOut = out.some((t) => getTitleId(t) === id || t.imdbId === id || t.tmdbId === id);
    if (existsInOut) continue;
    const p = remoteProgress[id];
    if (!p) continue;
    const imdbId = String(p.imdbId || '').trim();
    const tmdbId = String(p.tmdbId || '').trim();
    const type = 'movie'; // sin info de type, fallback a movie. El render no depende del type para mostrar.
    out.push({
      catalogKey: getCanonicalCatalogKey(type, imdbId, tmdbId, id, ''),
      type,
      imdbId,
      tmdbId,
      title: id, // sin metadata: el id es lo mejor que tenemos. Mejor que vacío.
      year: null,
      description: '',
      posterUrl: '',
      playable: true,
      metadata: { releaseDate: null, genres: [], backdropUrl: null, watchProviders: { region: '', flatrate: [] } }
    });
  }
  // Sort por recentAt (más reciente primero). Sin recentAt → al final.
  return out.sort((a, b) => {
    const aId = getTitleId(a);
    const bId = getTitleId(b);
    return (watch.recentAt[bId] || 0) - (watch.recentAt[aId] || 0);
  });
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
      catalogKey: getCanonicalCatalogKey(event?.type || 'movie', imdbId, tmdbId, event?.title || (imdbId || tmdbId || key), ''),
      type: String(event?.type || 'movie').trim() || 'movie',
      imdbId,
      tmdbId,
      title: String(event?.title || (imdbId || tmdbId || key)).trim(),
      year: null,
      description: '',
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
    // Linkear aliases imdb↔tmdb: el key del localStorage es imdbId o tmdbId,
    // pero getTitleId(t) puede retornar el otro. Sin esto, el filter de
    // Continuar Viendo no matchea aunque la entrada exista.
    const linked = aliasesById[id];
    if (linked) {
      for (const alt of linked) {
        scores[alt] = (scores[alt] || 0) + score;
        if (localUpdatedAt > (recentAt[alt] || 0)) recentAt[alt] = localUpdatedAt;
        if (completedLocal) completedIds.add(alt);
        else continueIds.add(alt);
      }
    }
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
  const keys = getTitlePreferenceKeys(title);
  if (!keys.length) return { like: 0, watchLater: false };
  return {
    like: Number(readTitlePreferenceValue(prefs?.likes, title, 0) || 0),
    watchLater: Boolean(readTitlePreferenceValue(prefs?.watchLater, title, false))
  };
}

function getCardQuickActions(title, prefs = loadTitlePrefs(), options = {}) {
  if (!isAuthenticated()) return '';
  const prefId = escapeAttribute(String(getTitleId(title) || ''));
  const flags = getTitleFlags(title, prefs);
  const likedClass = flags.like >= 1 ? ' active-like' : '';
  const laterClass = flags.watchLater ? ' active-later' : '';
  const withLabels = options.labels === true;
  const likeLabel = flags.like >= 1 ? 'Quitar me gusta' : 'Me gusta';
  const laterLabel = flags.watchLater ? 'Quitar de ver más tarde' : 'Ver más tarde';
  const likeContent = `❤${withLabels ? `<span class="quick-label">${escapeHtml(likeLabel)}</span>` : ''}`;
  const laterContent = `${flags.watchLater ? '✓' : '+'}${withLabels ? `<span class="quick-label">${escapeHtml(laterLabel)}</span>` : ''}`;
  return `<div class="item-quick-actions">
    <button class="item-quick-btn${likedClass}" type="button" data-pref-id="${prefId}" data-quick-action="like" aria-label="${escapeAttribute(likeLabel)}" aria-pressed="${flags.like >= 1 ? 'true' : 'false'}">${likeContent}</button>
    <button class="item-quick-btn${laterClass}" type="button" data-pref-id="${prefId}" data-quick-action="later" aria-label="${escapeAttribute(laterLabel)}" aria-pressed="${flags.watchLater ? 'true' : 'false'}">${laterContent}</button>
  </div>`;
}

function updateQuickActionButtons(prefId) {
  const id = String(prefId || '').trim();
  if (!id) return;
  const prefs = loadTitlePrefs();
  const relatedKeys = new Set([id]);
  getUnifiedTitlePool()
    .filter((title) => getTitlePreferenceKeys(title).includes(id))
    .forEach((title) => getTitlePreferenceKeys(title).forEach((key) => relatedKeys.add(key)));
  const likeActive = [...relatedKeys].some((key) => Number(prefs?.likes?.[key] || 0) >= 1);
  const laterActive = [...relatedKeys].some((key) => Boolean(prefs?.watchLater?.[key]));
  for (const key of relatedKeys) {
    document.querySelectorAll(`.item-quick-btn[data-pref-id="${CSS.escape(key)}"][data-quick-action="like"]`)
      .forEach((btn) => {
        btn.classList.toggle('active-like', likeActive);
        btn.setAttribute('aria-pressed', likeActive ? 'true' : 'false');
        btn.setAttribute('aria-label', likeActive ? 'Quitar me gusta' : 'Me gusta');
        const label = btn.querySelector('.quick-label');
        if (label) label.textContent = likeActive ? 'Quitar me gusta' : 'Me gusta';
      });
    document.querySelectorAll(`.item-quick-btn[data-pref-id="${CSS.escape(key)}"][data-quick-action="later"]`)
      .forEach((btn) => {
        btn.classList.toggle('active-later', laterActive);
        btn.setAttribute('aria-pressed', laterActive ? 'true' : 'false');
        btn.setAttribute('aria-label', laterActive ? 'Quitar de ver más tarde' : 'Ver más tarde');
        const label = btn.querySelector('.quick-label');
        if (label) label.textContent = laterActive ? 'Quitar de ver más tarde' : 'Ver más tarde';
        if (btn.firstChild && btn.firstChild.nodeType === Node.TEXT_NODE) btn.firstChild.textContent = laterActive ? '✓' : '+';
      });
  }
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

function cleanupWatchLaterFromCompleted(baseFiltered = null, watchOverride = null) {
  if (!isAuthenticated()) return;
  const prefs = loadTitlePrefs();
  const current = { ...(prefs.watchLater || {}) };
  if (!Object.keys(current).length) return;
  const watch = watchOverride || buildWatchInsights();
  const titles = Array.isArray(baseFiltered) ? baseFiltered : getFilteredLocalTitles();
  let changed = false;
  for (const title of titles) {
    const ids = getTitlePreferenceKeys(title);
    if (!ids.length || !ids.some((id) => current[id])) continue;
    const completed = ids.some((id) => watch.completedIds.has(id)) || isSeriesCompletedByLastEpisode(title);
    if (!completed) continue;
    for (const id of ids) delete current[id];
    changed = true;
  }
  if (changed) saveTitlePrefs({ ...prefs, watchLater: current });
}

function setTitlePreference(title, action) {
  if (!isAuthenticated() || !title) return;
  const id = getTitleId(title);
  if (!id || !getTitlePreferenceKeys(title).length) return;
  const prefs = loadTitlePrefs();
  const next = {
    likes: { ...(prefs.likes || {}) },
    watchLater: { ...(prefs.watchLater || {}) }
  };
  // Valores guardados como timestamp (Date.now()) en vez de 1/true para poder
  // ordenar "Me gusta" y "Ver más tarde" por orden de adición (más reciente
  // primero). Backward compatible: entradas viejas con valor 1/true cumplen
  // los filtros (>= 1 / Boolean) y sortean al final por ser el número más bajo.
  if (action === 'like') {
    const isLiked = Number(readTitlePreferenceValue(next.likes, title, 0) || 0) >= 1;
    writeTitlePreferenceValue(next.likes, title, isLiked ? 0 : Date.now());
  }
  else if (action === 'later') {
    const isLater = Boolean(readTitlePreferenceValue(next.watchLater, title, false));
    writeTitlePreferenceValue(next.watchLater, title, isLater ? false : Date.now());
  }
  saveTitlePrefs(next);
  void queueTitlePreferenceSync(title, action, {
    liked: Number(readTitlePreferenceValue(next.likes, title, 0) || 0) >= 1,
    watchLater: Boolean(readTitlePreferenceValue(next.watchLater, title, false))
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
    const poster = sanitizePosterUrl(title.posterUrl || title.metadata?.posterUrl || '');
    const isBareRoute = (title.description === 'Cargado desde ruta') || (title.title === (title.imdbId || title.tmdbId));
    elements.detail.innerHTML = `<div class="detail-inner overlay-open">
      <button class="back-chip" id="closeDetail" aria-label="Volver al inicio">
        <span class="back-chip-icon" aria-hidden="true">←</span>
        <span class="back-chip-label">Inicio</span>
      </button>
      <section class="title-hero">
        <div class="title-hero-bg" aria-hidden="true" style="${poster ? `--poster: url('${escapeAttribute(poster)}')` : ''}"></div>
        <div class="title-copy">
          <span class="title-kicker">Vista previa</span>
          <span class="pill">${escapeHtml(title.type)}</span>
          <h2>${escapeHtml(title.title)}</h2>
          ${getCardQuickActions(title)}
          <div class="detail-meta-row">${title.year ? `<span class="detail-meta-chip">${escapeHtml(String(title.year))}</span>` : ''}</div>
          <p class="title-description">${escapeHtml(title.description || 'Información no disponible.')}</p>
          ${isBareRoute ? '<p class="title-description">Metadata no disponible para este ID. Busca por nombre para obtener información.</p>' : ''}
          ${renderEvaluationPanel(title)}
        </div>
      </section>
    </div>`;

    document.querySelector('#closeDetail')?.addEventListener('click', returnToCatalogHome);

    bindEvaluationPanel(title);
    return;
  }

  const baseEmbed = buildEmbedUrl(title);
  state.playback.season = title.season || state.playback.season || 1;
  state.playback.episode = title.episode || state.playback.episode || 1;
  if (!skipHydratePlayback) applySavedWatchState(title);
  const poster = sanitizePosterUrl(title.posterUrl || title.metadata?.posterUrl || '');
  const progress = getSeriesProgress(title);
  const genres = (title.metadata?.genres ?? []).filter(Boolean);
  const castNames = (title.metadata?.cast ?? []).filter(Boolean);
  const hasEpisodes = isSeriesLike(title) && (state.seriesEpisodes?.seasons?.length ?? 0) > 0;
  const hasWatchHistory = Boolean(Object.keys(progress?.watched ?? {}).length) || Boolean(progress?.lastSeason && progress?.lastEpisode);
  const resumeTarget = hasEpisodes ? getResumeTarget(progress, state.seriesEpisodes) : null;
  const startTarget = hasEpisodes ? getStartTarget(state.seriesEpisodes) : null;
  const isPlayable = title.playable !== false;
  const titleMetaChips = [
    title.year ? String(title.year) : '',
    ...genres.slice(0, 3)
  ].filter(Boolean).map((entry) => `<span class="detail-meta-chip">${escapeHtml(entry)}</span>`).join('');
  const seasonsTabs = hasEpisodes ? state.seriesEpisodes.seasons.map((entry) => `<button class="season-tab${entry.seasonNumber === state.playback.season ? ' active' : ''}" data-season="${entry.seasonNumber}">T${entry.seasonNumber}</button>`).join('') : '';
  const currentSeasonEpisodes = hasEpisodes ? getEpisodesForSeason(state.playback.season) : [];
  const currentEpisodeEntry = currentSeasonEpisodes.find((entry) => entry.episode === state.playback.episode) || currentSeasonEpisodes[0] || null;
  const currentEpisodeStatus = currentEpisodeEntry
    ? (isEpisodeInProgress(progress, state.playback.season, currentEpisodeEntry.episode) ? 'En progreso' : isEpisodeWatched(progress, state.playback.season, currentEpisodeEntry.episode) ? 'Visto' : 'Listo para ver')
    : '';
  const episodeMeta = (entry) => [
    entry?.airDate ? formatDateShort(entry.airDate) : '',
    entry?.runtime ? `${positiveInteger(entry.runtime, 0)} min` : ''
  ].filter(Boolean).join(' · ');
  const currentEpisodeStill = sanitizePosterUrl(currentEpisodeEntry?.stillUrl || '');
  const episodeSpotlight = currentEpisodeEntry ? `<section class="episode-spotlight">
    <div class="episode-spotlight-art" aria-hidden="true" style="${currentEpisodeStill || poster ? `--poster: url('${escapeAttribute(currentEpisodeStill || poster)}')` : ''}">
      <span>T${escapeHtml(String(state.playback.season))}:E${escapeHtml(String(currentEpisodeEntry.episode))}</span>
    </div>
    <div class="episode-spotlight-copy">
      <span class="episode-spotlight-kicker">Capítulo seleccionado · ${escapeHtml(currentEpisodeStatus)}</span>
      <h3>${escapeHtml(currentEpisodeEntry.title || `Episodio ${currentEpisodeEntry.episode}`)}</h3>
      ${episodeMeta(currentEpisodeEntry) ? `<div class="episode-meta-row">${escapeHtml(episodeMeta(currentEpisodeEntry))}</div>` : ''}
      ${currentEpisodeEntry.overview ? `<p>${escapeHtml(currentEpisodeEntry.overview)}</p>` : '<p>Selecciona cualquier capítulo de la lista para reproducirlo directamente.</p>'}
      <button id="playSelectedEpisode" type="button">Reproducir T${escapeHtml(String(state.playback.season))}E${escapeHtml(String(currentEpisodeEntry.episode))}</button>
    </div>
  </section>` : '';
  const episodeCards = hasEpisodes ? currentSeasonEpisodes.map((entry) => {
    const watched = isEpisodeWatched(progress, state.playback.season, entry.episode);
    const inProgress = isEpisodeInProgress(progress, state.playback.season, entry.episode);
    const statusLabel = inProgress ? 'En progreso' : watched ? 'Visto' : 'Listo para ver';
    const stillUrl = sanitizePosterUrl(entry.stillUrl || '');
    return `<article class="episode-card${watched ? ' watched' : ''}${state.playback.episode === entry.episode ? ' current' : ''}" data-episode="${entry.episode}" role="button" tabindex="0">
      <div class="episode-thumb" aria-hidden="true" style="${stillUrl || poster ? `--poster: url('${escapeAttribute(stillUrl || poster)}')` : ''}">
        <span>${String(entry.episode).padStart(2, '0')}</span>
      </div>
      <div class="episode-copy">
        <span class="episode-code">Capítulo ${entry.episode}</span>
        <span class="episode-title">${escapeHtml(entry.title || `Episodio ${entry.episode}`)}</span>
        ${episodeMeta(entry) ? `<span class="episode-meta-row">${escapeHtml(episodeMeta(entry))}</span>` : ''}
        ${entry.overview ? `<span class="episode-overview">${escapeHtml(entry.overview)}</span>` : ''}
        <span class="episode-subtitle">${escapeHtml(statusLabel)}</span>
      </div>
      <span class="episode-play-cue" aria-hidden="true">${inProgress ? 'Continuar' : 'Ver ahora'}</span>
    </article>`;
  }).join('') : '';

  const availabilityBlock = isPlayable ? '' : `<div class="availability">
    <div class="availability-copy">
      <strong>No disponible en el momento</strong>
      <span>Las fuentes actuales no tienen este título listo para reproducir. Toca "Solicitar" para enviarlo a la cola — vuelve a intentar en unos días.</span>
    </div>
    <button id="requestTitle" type="button">Solicitar</button>
  </div>`;
  const issueActionLabel = 'Reportar problema';

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
        <span class="title-kicker">${isSeriesLike(title) ? 'Serie seleccionada' : 'Película seleccionada'}</span>
        <span class="pill">${escapeHtml(title.type)}</span>
        <h2>${escapeHtml(title.title)}</h2>
        ${getCardQuickActions(title)}
        <div class="detail-meta-row">${titleMetaChips}</div>
        <p class="title-description">${escapeHtml(title.description || 'Información no disponible.')}</p>
        ${castNames.length ? `<p class="title-meta">${escapeHtml(`Reparto: ${castNames.slice(0, 6).join(', ')}`)}</p>` : ''}
        ${metadataBlock}
        ${availabilityBlock}
        <div class="actions hero-actions">
          ${!isSeriesLike(title) ? `<button id="loadPlayer"${isPlayable ? '' : ' disabled'}>${isPlayable ? 'Reproducir' : 'No disponible'}</button>` : ''}
          ${isSeriesLike(title) && !hasWatchHistory && startTarget ? `<button id="startSeries"${isPlayable ? '' : ' disabled'}>${isPlayable ? `Ver T${startTarget.season}E${startTarget.episode}` : 'No disponible'}</button>` : ''}
          ${isSeriesLike(title) && hasWatchHistory && resumeTarget ? `<button id="resumeSeries"${isPlayable ? '' : ' disabled'}>${isPlayable ? escapeHtml(resumeTarget.label) : 'No disponible'}</button>` : ''}
        </div>
        <div class="detail-support-actions">
          <button id="reportIssue" type="button" class="ghost">${escapeHtml(issueActionLabel)}</button>
          ${isSeriesLike(title) && isAuthenticated() ? `<button id="refreshEpisodes" type="button" class="ghost"${state.seriesEpisodesLoading ? ' disabled' : ''}>Actualizar capítulos</button>` : ''}
        </div>
      </div>
    </section>
    ${isSeriesLike(title) ? `<section class="seasons-panel"><div class="seasons-tabs">${seasonsTabs || `<span class="episode-hint">${state.seriesEpisodesLoading ? 'Cargando temporadas...' : 'No se encontraron temporadas.'}</span>`}</div>${episodeSpotlight}${episodeCards ? `<div class="episodes-carousel" data-episodes-carousel><button class="episode-nav" type="button" data-episodes-prev aria-label="Capítulos anteriores">‹</button><div class="episodes-viewport"><div class="episodes-track">${episodeCards}</div></div><button class="episode-nav" type="button" data-episodes-next aria-label="Siguientes capítulos">›</button></div>` : `<div class="episode-hint">${state.seriesEpisodesLoading ? 'Cargando capítulos...' : 'No se encontraron capítulos.'}</div>`}</section>` : ''}
  </div>`;

  updateFloatingReportButtonVisibility();
  bindQuickActionButtons(elements.detail);

  bindTap(document.querySelector('#loadPlayer'), () => {
    if (!isPlayable) return;
    openPlayerForCurrentSelection();
  });
  bindTap(document.querySelector('#startSeries'), () => {
    if (!isPlayable) return;
    state.playback.season = startTarget.season;
    state.playback.episode = startTarget.episode;
    openPlayerForCurrentSelection();
  });
  bindTap(document.querySelector('#resumeSeries'), () => {
    if (!isPlayable) return;
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
  bindTap(document.querySelector('#playSelectedEpisode'), () => {
    if (currentEpisodeEntry) state.playback.episode = currentEpisodeEntry.episode;
    openPlayerForCurrentSelection();
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
    void openUserProblemReportForm({
      scope: 'title',
      label: title.title || title.imdbId || title.tmdbId || 'titulo',
      title: title.title || '',
      type: title.type || '',
      imdbId: title.imdbId || '',
      tmdbId: title.tmdbId || ''
    });
  });
  document.querySelector('#closeDetail')?.addEventListener('click', returnToCatalogHome);
  document.querySelectorAll('[data-season]').forEach((button) => button.addEventListener('click', () => { state.playback.season = positiveInteger(button.dataset.season, 1); renderDetail(); syncRoute(); }));
  document.querySelectorAll('[data-episode]').forEach((button) => {
    const onSelect = () => {
      playEpisodeCard(button);
    };
    bindTap(button, () => onSelect());
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onSelect();
    });
  });
}

// Escribe localStorage marcando la selección actual como "started" para
// que el título aparezca en Continuar Viendo aunque el provider del iframe
// no emita PLAYER_EVENT (solo vaplayer/Servidor 1 los emite). Si después
// el provider real emite progreso, persistProgressFromPlayerEvent
// sobreescribe con datos reales.
function markCurrentSelectionAsStarted() {
  const title = state.selected;
  if (!title) {
    dtvLog('player', 'markCurrentSelectionAsStarted skip — no state.selected');
    return;
  }
  const imdbId = String(title.imdbId || '').trim();
  const tmdbId = String(title.tmdbId || '').trim();
  const id = imdbId || tmdbId;
  if (!id) {
    dtvLog('player', 'markCurrentSelectionAsStarted skip — no imdb/tmdb id', { title: title.title });
    return;
  }
  const season = Number(state.playback.season || 1);
  const episode = Number(state.playback.episode || 1);
  const now = Date.now();
  const snapshot = { imdbId, tmdbId, season, episode, progress: 0 };
  localStorage.setItem('mep_last_watch', JSON.stringify(snapshot));
  const key = `mep_series_progress_${id}`;
  const existing = safeJson(localStorage.getItem(key)) || { watched: {} };
  const watched = existing.watched || {};
  const epKey = `s${season}e${episode}`;
  const prev = watched[epKey];
  const alreadyStarted = prev && prev !== true && prev.startedAt;
  if (!alreadyStarted) {
    watched[epKey] = (prev && prev !== true)
      ? { ...prev, startedAt: prev.startedAt || now }
      : { startedAt: now, completedAt: null, lastProgress: 0 };
    const nextProgress = { ...existing, lastSeason: season, lastEpisode: episode, watched };
    localStorage.setItem(key, JSON.stringify(nextProgress));
  }
  // Persistir en synced storage también: buildWatchInsights solo linkea
  // aliases imdb↔tmdb desde remoteProgress (no desde el loop local de
  // mep_series_progress_*). Sin esto, si el id local es imdbId pero
  // getTitleId(t) retorna tmdbId, el filter de Continuar Viendo no matchea.
  persistSyncedWatchSnapshot('progress', {
    imdbId,
    tmdbId,
    season,
    episode,
    progress: 0,
    player_status: 'playing',
    updatedAt: new Date().toISOString()
  });
  dtvLog('player', 'markCurrentSelectionAsStarted', {
    title: title.title, imdbId, tmdbId, season, episode, alreadyStarted
  });
  // Propagar a otros dispositivos vía GitHub issue (drain workflow lo recoge
  // y actualiza watch-analytics/users/<email>/data.json). El dedupe interno
  // de queueWatchProgressSync (30min para 'started') evita spam si el user
  // abre/cierra el player varias veces.
  if (!alreadyStarted) {
    void queueWatchProgressSync({
      imdbId,
      tmdbId,
      season,
      episode,
      progress: 0,
      player_status: 'playing',
      event_type: 'started',
      started_at: new Date(now).toISOString(),
      completed_at: ''
    });
  }
}

function openPlayerModal(embedUrl) {
  if (state.playerOpening) return;
  state.playerOpening = true;
  clearPlayerFallback();
  persistLastSelection();
  // Marca optimista: deja constancia local del "start" para que el título
  // aparezca en Continuar Viendo aunque el provider del iframe no emita
  // PLAYER_EVENT messages (vidsrc/2embed/vidlink/embedmaster no los emiten).
  // Si el Servidor 1 (vaplayer) sí emite progreso real, lo sobreescribe.
  markCurrentSelectionAsStarted();
  const modal = elements.playerModal;
  const card = modal?.querySelector('.player-modal-card');
  const iframe = elements.playerIframe;
  if (!modal || !iframe || !card) {
    state.playerOpening = false;
    return;
  }

  // Apertura fresca (modal estaba cerrado) → forzar Servidor 1 por defecto.
  // Si entramos con el modal ya visible (jumpEpisode), conservamos el provider
  // que el usuario haya elegido durante la sesión actual.
  if (modal.hidden) {
    state.activeProviderId = PLAYBACK_PROVIDERS[0].id;
  }

  renderPlayerControls();
  renderProviderTabs();
  const activeProvider = getActiveProvider();
  applyProviderSandbox(activeProvider);
  preloadSubsAsync(activeProvider, state.selected, state.playback.season, state.playback.episode);
  iframe.src = embedUrl;
  schedulePlayerFallback(getPlaybackUrlsForCurrentSelection(embedUrl));
  modal.hidden = false;
  document.body.classList.add('player-active');
  updateFloatingReportButtonVisibility();
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
  updateFloatingReportButtonVisibility();
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

async function searchViaListingsAndImdb(searchInput, typeFilter) {
  const search = typeof searchInput === 'string' ? parseSearchQuery(searchInput) : searchInput;
  const query = search?.term || '';
  const [fromListings, fromImdb, fromPeople] = await Promise.all([
    (search.mode === 'text' || search.mode === 'name') ? searchVidapiListings(query, typeFilter) : Promise.resolve([]),
    (search.mode === 'text' || search.mode === 'name') ? searchImdbSuggestionsViaJina(query, typeFilter) : Promise.resolve([]),
    search.mode === 'actor'
      ? searchTmdbPeopleCredits(query, typeFilter, 'actor')
      : search.mode === 'director'
        ? searchTmdbPeopleCredits(query, typeFilter, 'director')
        : search.mode === 'text'
          ? searchTmdbPeopleCredits(query, typeFilter, 'any')
          : Promise.resolve([])
  ]);
  return [...fromListings, ...fromImdb, ...fromPeople].filter((item) => hasPosterAsset(item));
}

async function searchVidapiListings(query, typeFilter) {
  const normalizedQuery = normalizeSearchText(query);
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
        const haystack = normalizeSearchText([normalized.title, normalized.description, normalized.imdbId].join(' '));
        if (haystack.includes(normalizedQuery)) results.push(normalized);
      }
      await sleep(50);
    }
  }
  return results;
}

async function searchTmdbPeopleCredits(query, typeFilter, personRole = 'any') {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery || normalizedQuery.length < 3) return [];

  try {
    // No `language` here on purpose: person names are not localized in a useful
    // way by TMDB, and using es-ES for some records returns the primary name in
    // the original script (e.g. 李连杰 for Jet Li), which would otherwise miss
    // our latin-script `query` and tank the score.
    const people = await tmdbFetchJson('/search/person', { query, page: 1, include_adult: false });
    const rankedPeople = (people.results || []).map((person, idx) => {
      const normalizedName = normalizeSearchText(person?.name);
      const alsoKnown = Array.isArray(person?.also_known_as)
        ? person.also_known_as.map(normalizeSearchText).filter(Boolean)
        : [];
      const allNames = [normalizedName].concat(alsoKnown).filter(Boolean);
      let score = 0;
      if (allNames.some((n) => n === normalizedQuery)) score += 300;
      if (allNames.some((n) => n.startsWith(normalizedQuery))) score += 180;
      if (allNames.some((n) => n.includes(normalizedQuery))) score += 120;
      // TMDB returned this person for our query → they're relevant somehow.
      // Reward earlier results so people whose primary name is in another
      // script (matched only via also_known_as) still rise to the top.
      score += Math.max(0, 80 - idx * 4);
      if (String(person?.known_for_department || '').trim().toLowerCase() === 'acting' && personRole === 'actor') score += 40;
      if (String(person?.known_for_department || '').trim().toLowerCase() === 'directing' && personRole === 'director') score += 40;
      score += Number(person?.popularity || 0);
      return { person, score };
    });
    const matches = rankedPeople
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.person)
      .slice(0, 5);
    if (!matches.length) return [];

    const creditsByPerson = await Promise.all(matches.map(async (person) => {
      try {
        const credits = await tmdbFetchJson(`/person/${encodeURIComponent(person.id)}/combined_credits`, { language: 'es-ES' });
        return buildTitlesFromPersonCredits(person, credits, typeFilter, personRole, query);
      } catch {
        return [];
      }
    }));
    return dedupe(creditsByPerson.flat(), { consolidateEquivalent: true });
  } catch {
    return [];
  }
}

function buildTitlesFromPersonCredits(person, credits, typeFilter, personRole = 'any', queryName = '') {
  const personName = String(person?.name || '').trim();
  if (!personName) return [];

  const castItems = personRole === 'director' ? [] : (credits?.cast || []).map((entry) => ({ entry, role: 'cast' }));
  const directedItems = personRole === 'actor' ? [] : (credits?.crew || [])
    .filter((entry) => String(entry?.job || '').trim().toLowerCase() === 'director')
    .map((entry) => ({ entry, role: 'director' }));

  // Build an alias list so matchesSearchFilters can match the user's query
  // against the cast even when TMDB's primary name is in another script
  // (e.g. 李连杰 vs "jet li").
  const aliases = personCreditAliases(person, queryName);

  return [...castItems, ...directedItems]
    .map(({ entry, role }) => normalizePersonCreditResult(entry, role, aliases, personRole))
    .filter((item) => item && (typeFilter === 'all' || item.type === typeFilter));
}

function personCreditAliases(person, queryName) {
  const primary = String(person?.name || '').trim();
  const knownAs = Array.isArray(person?.also_known_as) ? person.also_known_as : [];
  const aliases = [primary];
  const seen = new Set([normalizeSearchText(primary)]);
  const pushAlias = (raw) => {
    const value = String(raw || '').trim();
    if (!value) return;
    const key = normalizeSearchText(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    aliases.push(value);
  };
  for (const alias of knownAs) pushAlias(alias);
  // Always include a properly-cased version of the user's query so that
  // `a:jet li` still matches a title whose canonical cast entry is "李连杰".
  if (queryName) {
    const normQuery = normalizeSearchText(queryName);
    if (normQuery && !seen.has(normQuery)) {
      pushAlias(queryName
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' '));
    }
  }
  return aliases;
}

function isSelfLikeCredit(entry) {
  const character = normalizeSearchText(entry?.character || entry?.job || '');
  if (!character) return false;
  return ['self', 'host', 'guest', 'himself', 'herself', 'presenter'].some((term) => character.includes(term));
}

function isNoisyPersonCredit(entry, role, personName, personRole) {
  const mediaType = String(entry?.media_type || '').trim().toLowerCase();
  const genreIds = Array.isArray(entry?.genre_ids) ? entry.genre_ids.map((id) => Number(id) || 0) : [];
  const title = normalizeSearchText(entry?.title || entry?.name || '');
  const person = normalizeSearchText(personName);
  const episodeCount = Number(entry?.episode_count || 0) || 0;
  const selfLike = isSelfLikeCredit(entry);
  const isDocumentary = genreIds.includes(99);
  const isTalkOrVariety = genreIds.some((id) => [10763, 10764, 10767].includes(id));
  const isShortGuestSpot = mediaType === 'tv' && episodeCount > 0 && episodeCount <= 2;
  const titleMentionsPerson = person && title.includes(person);

  if (mediaType === 'tv' && isTalkOrVariety) return true;
  if (mediaType === 'tv' && isShortGuestSpot && (selfLike || !String(entry?.character || '').trim())) return true;
  if (role === 'cast' && personRole === 'actor' && isDocumentary && selfLike) return true;
  if (role === 'cast' && personRole === 'actor' && isDocumentary && titleMentionsPerson) return true;
  if (role === 'cast' && personRole === 'actor' && mediaType === 'movie' && selfLike && titleMentionsPerson) return true;
  return false;
}

function normalizePersonCreditResult(entry, role, aliases, personRole = 'any') {
  const aliasList = Array.isArray(aliases) ? aliases.filter(Boolean) : [String(aliases || '').trim()].filter(Boolean);
  const personName = aliasList[0] || '';
  const mediaType = String(entry?.media_type || '').trim().toLowerCase();
  const type = mediaType === 'tv' ? 'series' : mediaType === 'movie' ? 'movie' : '';
  if (!type) return null;
  if (isNoisyPersonCredit(entry, role, personName, personRole)) return null;

  const title = String(entry?.title || entry?.name || '').trim();
  if (!title) return null;

  return {
    imdbId: '',
    tmdbId: entry?.id ? String(entry.id) : '',
    title,
    year: Number(String(entry?.release_date || entry?.first_air_date || '').slice(0, 4)) || null,
    type,
    posterUrl: entry?.poster_path ? `https://image.tmdb.org/t/p/w500${entry.poster_path}` : '',
    description: String(entry?.overview || '').trim(),
    metadata: {
      posterUrl: entry?.poster_path ? `https://image.tmdb.org/t/p/w500${entry.poster_path}` : '',
      releaseDate: entry?.first_air_date || entry?.release_date || null,
      originalTitle: String(entry?.original_title || entry?.original_name || '').trim(),
      genres: [],
      cast: role === 'cast' ? aliasList : [],
      directors: role === 'director' ? aliasList : [],
      backdropUrl: entry?.backdrop_path ? `https://image.tmdb.org/t/p/w780${entry.backdrop_path}` : null
    }
  };
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
    entries.push({ season, episode, title: `Episodio ${episode}` });
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
          title: String(episode?.name || '').trim() || `Episodio ${episode?.episode_number}`,
          overview: String(episode?.overview || '').trim(),
          airDate: String(episode?.air_date || '').trim(),
          runtime: Number(episode?.runtime || 0) || 0,
          stillUrl: episode?.still_path ? `https://image.tmdb.org/t/p/w300${episode.still_path}` : ''
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
  if (Array.isArray(state.localCatalogCache)) return state.localCatalogCache;
  try {
    const raw = localStorage.getItem('mep_static_catalog') || '[]';
    if (raw.length > 800000) {
      localStorage.removeItem('mep_static_catalog');
      localStorage.removeItem('mep_seed_version');
      state.localCatalogCache = [];
      return state.localCatalogCache;
    }
    state.localCatalogCache = (JSON.parse(raw) || []).map((item) => normalizeCatalogPoster(item));
    return state.localCatalogCache;
  } catch {
    state.localCatalogCache = [];
    return state.localCatalogCache;
  }
}
function normalizeCatalogPoster(title) {
  const posterUrl = sanitizePosterUrl(title?.posterUrl || title?.metadata?.posterUrl || '');
  return {
    ...(title || {}),
    posterUrl,
    metadata: {
      ...(title?.metadata || {}),
      posterUrl
    }
  };
}
function saveLocalCatalog(items) {
  const normalized = (Array.isArray(items) ? items : []).map((item) => normalizeCatalogPoster(item));
  state.localCatalogCache = normalized;
  invalidateCatalogCaches();
  localStorage.setItem('mep_static_catalog', JSON.stringify(normalized));
}

function setRuntimeCatalog(items) {
  state.localCatalogCache = (Array.isArray(items) ? items : []).map((item) => normalizeCatalogPoster(item));
  invalidateCatalogCaches();
}

function invalidateCatalogCaches() {
  state.genreFilterCacheKey = '';
  state.genreFilterOptionsHtml = '';
  state.filteredCatalogCacheKey = '';
  state.filteredCatalogCache = null;
}
function hasPosterAsset(title) { return Boolean(sanitizePosterUrl(title?.posterUrl || title?.metadata?.posterUrl || '')); }
function filterTitlesWithPoster(items) { return (Array.isArray(items) ? items : []).filter((item) => hasPosterAsset(item)); }

function cacheSearchResults(results) {
  const current = loadLocalCatalog();
  const merged = dedupe([...current, ...filterTitlesWithPoster(results)], { consolidateEquivalent: true });
  state.localCatalogCache = merged;
  state.genreFilterCacheKey = '';
  state.genreFilterOptionsHtml = '';
  state.filteredCatalogCacheKey = '';
  state.filteredCatalogCache = null;
}

function dedupe(items, options = {}) {
  const { consolidateEquivalent = false } = options;
  const map = new Map();
  const aliasToCanonical = new Map();
  for (const item of items) {
    const primaryKey = `${item.type}:${item.imdbId || ''}:${item.tmdbId || ''}:${item.season || ''}:${item.episode || ''}`;
    const fallbackKey = `${item.type}:title:${String(item.title || '').trim().toLowerCase()}:${String(item.year || '')}`;
    const equivalentKeys = consolidateEquivalent
      ? [
          item.imdbId ? `${item.type}:imdb:${item.imdbId}` : '',
          item.tmdbId ? `${item.type}:tmdb:${item.tmdbId}` : '',
          fallbackKey
        ].filter(Boolean)
      : [primaryKey];
    const key = equivalentKeys.map((candidate) => aliasToCanonical.get(candidate) || candidate).find((candidate) => map.has(candidate)) || equivalentKeys[0];
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      for (const alias of equivalentKeys) aliasToCanonical.set(alias, key);
      continue;
    }
    const merged = mergeEquivalentTitles(existing, item);
    map.set(key, merged);
    const mergedFallbackKey = `${merged.type}:title:${String(merged.title || '').trim().toLowerCase()}:${String(merged.year || '')}`;
    const mergedAliases = consolidateEquivalent
      ? [
          merged.imdbId ? `${merged.type}:imdb:${merged.imdbId}` : '',
          merged.tmdbId ? `${merged.type}:tmdb:${merged.tmdbId}` : '',
          mergedFallbackKey
        ].filter(Boolean)
      : [key];
    for (const alias of [...equivalentKeys, ...mergedAliases]) aliasToCanonical.set(alias, key);
  }
  return [...map.values()];
}

function mergeEquivalentTitles(a, b) {
  const choose = (first, second) => (first !== undefined && first !== null && String(first) !== '' ? first : second);
  const imdbId = choose(a.imdbId, b.imdbId) || choose(b.imdbId, a.imdbId);
  const tmdbId = choose(a.tmdbId, b.tmdbId) || choose(b.tmdbId, a.tmdbId);
  const title = choose(a.title, b.title);
  const year = choose(a.year, b.year);
  return {
    ...a,
    ...b,
    catalogKey: getCanonicalCatalogKey(a.type || b.type, imdbId, tmdbId, title, year),
    imdbId,
    tmdbId,
    title,
    year,
    description: choose(a.description, b.description),
    posterUrl: choose(a.posterUrl, b.posterUrl) || choose(a.metadata?.posterUrl, b.metadata?.posterUrl) || choose(b.posterUrl, a.posterUrl) || choose(b.metadata?.posterUrl, a.metadata?.posterUrl),
    playable: a.playable === false && b.playable !== false ? b.playable : (b.playable === false && a.playable !== false ? a.playable : (a.playable === false || b.playable === false ? false : true)),
    metadata: {
      ...(a.metadata || {}),
      ...(b.metadata || {}),
      posterUrl: choose(a.posterUrl, b.posterUrl) || choose(a.metadata?.posterUrl, b.metadata?.posterUrl) || choose(b.posterUrl, a.posterUrl) || choose(b.metadata?.posterUrl, a.metadata?.posterUrl),
      originalTitle: choose(a.metadata?.originalTitle, b.metadata?.originalTitle) || choose(b.metadata?.originalTitle, a.metadata?.originalTitle) || '',
      genres: uniqNames([...(a.metadata?.genres || []), ...(b.metadata?.genres || []), ...(a.categories || []), ...(b.categories || [])]),
      cast: uniqNames([...(a.metadata?.cast || []), ...(b.metadata?.cast || [])]),
      directors: uniqNames([...(a.metadata?.directors || []), ...(b.metadata?.directors || [])])
    }
  };
}
function mergeAndRankResults(localResults, remoteResults, query) {
  return sortByRelevance(dedupe([...localResults.map((title) => ({ ...title, source: 'local' })), ...remoteResults.map((title) => ({ ...title, source: 'remote' }))], { consolidateEquivalent: true }), query)
    .map((title) => ({ source: title.source || 'remote', title }));
}
function sortByRelevance(items, query) { const q = normalizeSearchText(query); return [...items].sort((a, b) => relevanceScore(b, q) - relevanceScore(a, q)); }
function relevanceScore(item, query) {
  const title = normalizeSearchText(item.title);
  const cast = (item.metadata?.cast || []).map((name) => normalizeSearchText(name));
  const directors = (item.metadata?.directors || []).map((name) => normalizeSearchText(name));
  const genres = (item.metadata?.genres || item.categories || []).map((name) => normalizeSearchText(name));
  let score = 0;
  if (title === query) score += 200;
  if (title.startsWith(query)) score += 120;
  if (title.includes(query)) score += 80;
  if (cast.some((name) => name === query) || directors.some((name) => name === query)) score += 145;
  if (cast.some((name) => name.includes(query)) || directors.some((name) => name.includes(query))) score += 95;
  if (genres.some((name) => name === query)) score += 40;
  if (genres.some((name) => name.includes(query))) score += 18;
  if (item.type === 'series') score += 8;
  if (item.posterUrl) score += 5;
  return score;
}

function normalizeSelection(remote) {
  return {
    catalogKey: getCanonicalCatalogKey(remote.type, remote.imdbId, remote.tmdbId, remote.title, remote.year),
    ...remote
  };
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
function getActiveProvider() {
  if (!state.activeProviderId) {
    state.activeProviderId = PLAYBACK_PROVIDERS[0].id;
  }
  return PLAYBACK_PROVIDERS.find((p) => p.id === state.activeProviderId) || PLAYBACK_PROVIDERS[0];
}

function buildEmbedUrlWithProvider(entry, provider) {
  const id = getPlaybackId(entry);
  return entry.type === 'movie'
    ? provider.movie(id, entry)
    : provider.tv(id, entry.season || 1, entry.episode || 1, entry);
}

function buildEmbedUrl(entry) {
  return buildEmbedUrlWithProvider(entry, getActiveProvider());
}

function getPlaybackUrlsForCurrentSelection(primaryUrl) {
  if (!state.selected) return [primaryUrl];
  const ids = getPlaybackCandidateIds(state.selected);
  if (!ids.length) return [primaryUrl];
  const provider = getActiveProvider();
  const season = state.playback.season || 1;
  const episode = state.playback.episode || 1;
  const entry = state.selected;
  const urls = ids.map((id) => entry.type === 'movie'
    ? provider.movie(id, entry)
    : provider.tv(id, season, episode, entry));
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
    if (!next) return;
    // Aviso visible antes de cambiar el iframe.src: sin esto el user veía
    // el player "saltar" a otro URL sin explicación tras ~6.5s de espera.
    dtvLog('player', 'fallback to alternate URL', { from: current, to: next });
    showToast({
      icon: 'warning',
      title: 'El servidor no respondió. Probando una fuente alternativa…',
      timer: 4000
    });
    iframe.src = next;
  }, PLAYER_FALLBACK_DELAY_MS);
}
function isSeriesLike(title) { return title.type === 'series' || title.type === 'episode'; }
function getCurrentEmbedUrl(baseEmbed) {
  if (!isSeriesLike(state.selected)) return baseEmbed;
  const id = getPlaybackId(state.selected);
  const provider = getActiveProvider();
  return provider.tv(id, state.playback.season, state.playback.episode, state.selected);
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
  dtvLog('player', 'PLAYER_EVENT received', { status: data?.player_status, progress: data?.player_progress, imdb: data?.player_info?.imdb, tmdb: data?.player_info?.tmdb });
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

// Botón propio de pantalla completa. Necesario porque algunos providers
// (notablemente embedmaster/Servidor 5) implementan su botón de "fullscreen"
// como un CSS interno (expandir a 100vw/100vh dentro del iframe) en lugar
// de llamar a la Fullscreen API real del navegador — queda fullscreen
// "dentro del browser" pero no del SO.
//
// Pedimos fullscreen sobre el IFRAME directamente (no sobre el card):
// 1) Los browsers son más permisivos con iframes/media que con divs random
//    (Safari iOS solo entra fullscreen sobre <video>/<iframe>).
// 2) UX mejor: el video llena la pantalla sin la barra de controles arriba.
// Fallback al card si el iframe rechaza, y loggeo del error a consola para
// diagnóstico.
function togglePlayerFullscreen() {
  if (document.fullscreenElement) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (typeof exit === 'function') {
      const p = exit.call(document);
      if (p && typeof p.catch === 'function') p.catch((err) => dtvLog('error', 'exitFullscreen failed', String(err)));
    }
    return;
  }
  const iframe = elements.playerIframe;
  const card = elements.playerModal?.querySelector('.player-modal-card');
  const tryFullscreen = (el) => {
    if (!el) return false;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (typeof fn !== 'function') return false;
    const p = fn.call(el);
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        dtvLog('error', 'requestFullscreen failed', String(err));
        // Si el iframe falló (algunos browsers exigen <video>), reintentar con card.
        if (el === iframe && card) tryFullscreen(card);
      });
    }
    return true;
  };
  if (!tryFullscreen(iframe)) tryFullscreen(card);
}

function updateFullscreenButtonLabel() {
  const btn = elements.playerControls?.querySelector('[data-player-action="fullscreen"]');
  if (!btn) return;
  btn.textContent = document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa';
}

function bindPlayerModalEvents() {
  const modal = elements.playerModal;
  if (!modal) return;
  modal.querySelector('[data-close-player]')?.addEventListener('click', closePlayerModal);
}

function renderProviderTabs() {
  const container = elements.playerServerTabs;
  if (!container) return;
  // Con un solo provider no hay nada que escoger: ocultar tabs.
  if (PLAYBACK_PROVIDERS.length <= 1) {
    container.innerHTML = '';
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const active = getActiveProvider();
  container.innerHTML = PLAYBACK_PROVIDERS.map((provider) => {
    const isActive = provider.id === active.id;
    return `
      <button type="button"
              class="player-server-tab${isActive ? ' active' : ''}"
              data-provider-id="${provider.id}"
              aria-pressed="${isActive}"
              title="${provider.note}">
        <span class="player-server-tab-label">${provider.label}</span>
        <span class="player-server-tab-note">${provider.note}</span>
      </button>
    `;
  }).join('');
  container.querySelectorAll('[data-provider-id]').forEach((button) => {
    button.addEventListener('click', () => setActiveProvider(button.dataset.providerId));
  });
}

// Toast no-bloqueante "Cargando subtítulos…" mostrado solo cuando el
// provider tiene subsUrl configurado (vidlink, embedmaster). El fetch
// es fire-and-forget para calentar la cache de Cloudflare edge — el
// iframe del provider luego hace SU fetch que pega en cache caliente.
function preloadSubsAsync(provider, entry, season, episode) {
  if (!provider || typeof provider.subsUrl !== 'function' || !entry) return;
  const subUrl = provider.subsUrl(entry, season, episode);
  if (!subUrl) return;
  if (typeof Swal !== 'undefined') {
    Swal.fire({
      toast: true,
      position: 'top-end',
      icon: 'info',
      title: 'Cargando subtítulos en español…',
      showConfirmButton: false,
      timer: 3500,
      timerProgressBar: true
    });
  }
  // Fire-and-forget. Cualquier error es transparente — el iframe
  // siempre puede fetchar por su cuenta.
  fetch(subUrl, { mode: 'cors', credentials: 'omit' }).catch(() => {});
}

function applyProviderSandbox(provider) {
  if (!elements.playerIframe || !provider) return;
  // sandbox: null en el provider → quitar el atributo por completo (el provider
  // detecta el sandbox por JS y bloquea reproducción si lo encuentra; trade-off
  // de seguridad aceptado para que reproduzca).
  if (provider.sandbox === null || provider.sandbox === '') {
    if (elements.playerIframe.hasAttribute('sandbox')) {
      elements.playerIframe.removeAttribute('sandbox');
    }
    return;
  }
  const desired = provider.sandbox || DEFAULT_PLAYER_SANDBOX;
  if (elements.playerIframe.getAttribute('sandbox') !== desired) {
    elements.playerIframe.setAttribute('sandbox', desired);
  }
}

function setActiveProvider(providerId) {
  const provider = PLAYBACK_PROVIDERS.find((p) => p.id === providerId);
  if (!provider || provider.id === state.activeProviderId) return;
  state.activeProviderId = provider.id;
  renderProviderTabs();
  if (state.selected && elements.playerModal && !elements.playerModal.hidden) {
    const newUrl = buildEmbedUrl(state.selected);
    applyProviderSandbox(provider);
    preloadSubsAsync(provider, state.selected, state.playback.season, state.playback.episode);
    elements.playerIframe.src = newUrl;
    schedulePlayerFallback(getPlaybackUrlsForCurrentSelection(newUrl));
  }
}

function renderPlayerControls() {
  if (!elements.playerControls) return;
  const fullscreenLabel = document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa';
  const fullscreenButton = `<button class="player-nav" data-player-action="fullscreen">${fullscreenLabel}</button>`;
  if (isSeriesLike(state.selected)) {
    elements.playerControls.innerHTML = `
      <div class="player-nav-row">
        <button class="player-nav" data-player-action="back">Volver a la serie</button>
        <button class="player-nav" data-player-action="prev">Capítulo anterior</button>
        <button class="player-nav" data-player-action="next">Siguiente capítulo</button>
        ${fullscreenButton}
      </div>
    `;
  } else {
    elements.playerControls.innerHTML = `
      <div class="player-nav-row">
        <button class="player-nav" data-player-action="close">Cerrar</button>
        ${fullscreenButton}
      </div>
    `;
  }
  elements.playerControls.querySelectorAll('[data-player-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.playerAction;
      if (action === 'close' || action === 'back') {
        closePlayerModal();
        return;
      }
      if (action === 'fullscreen') {
        togglePlayerFullscreen();
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

function syncRoute(options = {}) {
  const { force = false } = options;
  if (suppressRouteSync && !force) return;
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
  const currentRouteToken = ++routeChangeToken;
  const isStaleRouteChange = () => currentRouteToken !== routeChangeToken;
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
      const selectedId = String(state.selected.imdbId || state.selected.tmdbId || '').trim();
      hydrateSelectedFromTmdb().then(() => {
        const activeId = String(state.selected?.imdbId || state.selected?.tmdbId || '').trim();
        if (isStaleRouteChange() || activeId !== selectedId) return;
        renderDetail({ skipHydratePlayback: true });
      });
      if (shouldOpenPlayer) {
        // iOS Safari can be flaky about repainting fixed overlays immediately;
        // deferring a tick makes the modal+hash transition more reliable.
        const target = getCurrentEmbedUrl(buildEmbedUrl(state.selected));
        setTimeout(() => {
          if (isStaleRouteChange()) return;
          openPlayerModal(target);
        }, 0);
      }
      if (isAuthenticated() && isSeriesLike(state.selected)) {
        await loadSeriesEpisodes();
        if (isStaleRouteChange()) return;
        renderDetail({ skipHydratePlayback: shouldOpenPlayer });
      }
      if (isStaleRouteChange()) return;
      if (!document.body.classList.contains('detail-active')) renderCatalog();
      if (!shouldOpenPlayer) closePlayerModal();
    } else {
      renderCatalog();
      if (isAuthenticated()) {
        const search = parseSearchQuery(q);
        if (getSearchTermLength(search) >= 3 && searchSupportsRemote(search.mode)) await searchRemoteCatalog(search);
        if (isStaleRouteChange()) return;
      }
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
