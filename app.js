const state = {
  selected: null,
  seriesEpisodes: null,
  seriesEpisodesLoading: false,
  hydratedProgressId: '',
  remoteResults: [],
  remoteSearchTimer: null,
  lastRemoteQuery: '',
  isSearching: false,
  playback: { season: 1, episode: 1 },
  playerOpening: false
};
let suppressRouteSync = false;
let episodeIndexPromise = null;

const elements = {
  search: document.querySelector('#search'),
  typeFilter: document.querySelector('#typeFilter'),
  tabs: document.querySelectorAll('[data-type-tab]'),
  items: document.querySelector('#items'),
  count: document.querySelector('#count'),
  detail: document.querySelector('#detail'),
  playerModal: document.querySelector('#playerModal'),
  playerIframe: document.querySelector('#player'),
  playerControls: document.querySelector('#playerControls')
};

elements.search.addEventListener('input', () => {
  renderCatalog();
  scheduleRemoteSearch();
});
elements.typeFilter.addEventListener('change', () => {
  syncTabs(elements.typeFilter.value);
  renderCatalog();
  scheduleRemoteSearch();
});
elements.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    elements.typeFilter.value = tab.dataset.typeTab;
    syncTabs(tab.dataset.typeTab);
    renderCatalog();
    scheduleRemoteSearch();
  });
});

window.addEventListener('hashchange', handleRouteChange);
bindPlayerModalEvents();
handleRouteChange();

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
  const query = elements.search.value.trim();
  const filtered = getFilteredLocalTitles();
  elements.count.textContent = `${filtered.length} items`;
  elements.items.innerHTML = renderLocalCards(filtered);
  bindLocalCardEvents();

  if (filtered.length === 0 && query.length >= 3 && state.isSearching) {
    elements.items.innerHTML = `<div class="loader-card"><span class="spinner"></span><strong>Searching IMDb/TMDB</strong><p>Looking for playable titles...</p></div>`;
  }
}

function getFilteredLocalTitles() {
  const query = elements.search.value.trim().toLowerCase();
  const type = elements.typeFilter.value;
  const titles = loadLocalCatalog();
  return titles.filter((title) => {
    if (title.type === 'episode') return false;
    const haystack = [title.title, title.showTitle, title.imdbId, title.tmdbId].join(' ').toLowerCase();
    return (type === 'all' || title.type === type) && (!query || haystack.includes(query));
  });
}

function renderLocalCards(titles) {
  return titles.map((title) => {
    const active = state.selected?.catalogKey === title.catalogKey ? ' active' : '';
    const poster = title.posterUrl || title.metadata?.posterUrl || '';
    return `<article class="item${active}" data-key="${escapeHtml(title.catalogKey)}">
      ${poster ? `<img class="item-poster" src="${escapeAttribute(poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="item-poster placeholder"></div>'}
      <div><strong>${escapeHtml(title.title)}</strong><span class="meta">${escapeHtml(title.type)} | IMDb: ${escapeHtml(title.imdbId || '-')} | ${escapeHtml(title.year ?? '')}</span><span class="meta">${escapeHtml(title.description || 'IMDb result')}</span></div>
    </article>`;
  }).join('');
}

function bindLocalCardEvents() {
  elements.items.querySelectorAll('.item').forEach((item) => {
    if (!item.dataset.key) return;
    item.addEventListener('click', async () => {
      state.selected = loadLocalCatalog().find((title) => title.catalogKey === item.dataset.key);
      state.seriesEpisodes = null;
      state.seriesEpisodesLoading = isSeriesLike(state.selected);
      state.hydratedProgressId = '';
      renderCatalog();
      renderDetail();
      if (isSeriesLike(state.selected)) loadSeriesEpisodes().then(renderDetail);
      syncRoute();
    });
  });
}

function scheduleRemoteSearch() {
  clearTimeout(state.remoteSearchTimer);
  const query = elements.search.value.trim();
  if (query.length < 3) return;
  state.isSearching = true;
  renderCatalog();
  state.remoteSearchTimer = setTimeout(async () => {
    if (state.lastRemoteQuery === query.toLowerCase()) return;
    state.lastRemoteQuery = query.toLowerCase();
    await searchRemoteCatalog(query);
    state.isSearching = false;
    syncRoute();
  }, 450);
}

async function searchRemoteCatalog(query) {
  try {
    const results = await searchViaListingsAndImdb(query, elements.typeFilter.value);
    const filtered = await filterUnavailableSeries(results);
    state.remoteResults = sortByRelevance(dedupe(filtered), query).slice(0, 36).map(normalizeSelection);
    cacheSearchResults(state.remoteResults);
    renderRemoteResults(query);
  } catch (error) {
    elements.items.innerHTML = `<div class="empty error">Search failed: ${escapeHtml(error.message)}</div>`;
  }
}

function renderRemoteResults(query) {
  const localResults = getFilteredLocalTitles();
  const merged = mergeAndRankResults(localResults, state.remoteResults, query);
  elements.count.textContent = `${merged.length} matches for "${query}"`;
  elements.items.innerHTML = merged.map((entry, index) => {
    const title = entry.title;
    const poster = title.posterUrl || '';
    return `<article class="item" ${entry.source === 'remote' ? `data-remote-index="${index}"` : `data-key="${escapeHtml(title.catalogKey)}"`}>
      ${poster ? `<img class="item-poster" src="${escapeAttribute(poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="item-poster placeholder"></div>'}
      <div><strong>${escapeHtml(title.title)}</strong><span class="meta">${escapeHtml(title.type)} | IMDb: ${escapeHtml(title.imdbId || '-')} | ${escapeHtml(title.year ?? '')}</span><span class="meta">${escapeHtml(title.description || 'IMDb result')}</span></div>
    </article>`;
  }).join('') || '<div class="empty">No playable results found for this query.</div>';

  elements.items.querySelectorAll('[data-remote-index]').forEach((item) => {
    item.addEventListener('click', () => {
      const remote = merged[Number(item.dataset.remoteIndex)]?.title;
      if (!remote) return;
      state.selected = remote;
      state.seriesEpisodes = null;
      state.seriesEpisodesLoading = isSeriesLike(state.selected);
      state.hydratedProgressId = '';
      renderRemoteResults(elements.search.value.trim());
      renderDetail();
      if (isSeriesLike(state.selected)) loadSeriesEpisodes().then(renderDetail);
      syncRoute();
    });
  });
  bindLocalCardEvents();
}

function renderDetail(options = {}) {
  const { skipHydratePlayback = false } = options;
  const title = state.selected;
  if (!title) {
    document.body.classList.remove('detail-active');
    elements.detail.innerHTML = '<div class="empty">Search and select a title to preview.</div>';
    return;
  }

  document.body.classList.add('detail-active');

  const baseEmbed = buildEmbedUrl(title);
  state.playback.season = title.season || state.playback.season || 1;
  state.playback.episode = title.episode || state.playback.episode || 1;
  if (!skipHydratePlayback) applySavedWatchState(title);
  const poster = title.posterUrl || '';
  const progress = getSeriesProgress(title);
  const hasEpisodes = isSeriesLike(title) && (state.seriesEpisodes?.seasons?.length ?? 0) > 0;
  const hasWatchHistory = Boolean(Object.keys(progress?.watched ?? {}).length);
  const resumeTarget = hasEpisodes ? getNextEpisodeTarget(progress, state.seriesEpisodes) : null;
  const seasonsTabs = hasEpisodes ? state.seriesEpisodes.seasons.map((entry) => `<button class="season-tab${entry.seasonNumber === state.playback.season ? ' active' : ''}" data-season="${entry.seasonNumber}">T${entry.seasonNumber}</button>`).join('') : '';
  const episodeCards = hasEpisodes ? getEpisodesForSeason(state.playback.season).map((entry) => {
    const watched = isEpisodeWatched(progress, state.playback.season, entry.episode);
    return `<button class="episode-card${watched ? ' watched' : ''}${state.playback.episode === entry.episode ? ' current' : ''}" data-episode="${entry.episode}">
      <span class="episode-code">E${entry.episode}</span><span class="episode-title">${escapeHtml(entry.title || `Episode ${entry.episode}`)}</span>${watched ? '<span class="episode-status">Visto</span>' : ''}
    </button>`;
  }).join('') : '';

  elements.detail.innerHTML = `<div class="detail-inner overlay-open">
    <button class="overlay-close back-chip" id="closeDetail" aria-label="Volver al inicio">
      <span class="back-chip-icon" aria-hidden="true">←</span>
      <span class="back-chip-label">Inicio</span>
    </button>
    <section class="title-hero" style="${poster ? `--poster: url('${escapeAttribute(poster)}')` : ''}">
      <div class="title-copy">
        <span class="pill">${escapeHtml(title.type)}</span>
        <h2>${escapeHtml(title.title)}</h2>
        <p class="title-meta">${escapeHtml([title.year].filter(Boolean).join(' | '))}</p>
        <p class="title-description">${escapeHtml(title.description || 'Información no disponible.')}</p>
        <div class="actions hero-actions">
          ${!isSeriesLike(title) ? '<button id="loadPlayer">Play</button>' : '<button id="playSeries">Play</button>'}
          ${isSeriesLike(title) && hasWatchHistory && resumeTarget ? `<button id="resumeSeries">Reanudar T${resumeTarget.season}E${resumeTarget.episode}</button>` : ''}
        </div>
      </div>
    </section>
    ${isSeriesLike(title) ? `<section class="seasons-panel"><div class="seasons-tabs">${seasonsTabs || `<span class="episode-hint">${state.seriesEpisodesLoading ? 'Cargando temporadas...' : 'No se encontraron temporadas.'}</span>`}</div><div class="episodes-grid">${episodeCards || `<span class="episode-hint">${state.seriesEpisodesLoading ? 'Cargando capítulos...' : 'No se encontraron capítulos.'}</span>`}</div></section>` : ''}
  </div>`;

  bindTap(document.querySelector('#loadPlayer'), () => openPlayerForCurrentSelection());
  bindTap(document.querySelector('#playSeries'), () => openPlayerForCurrentSelection());
  bindTap(document.querySelector('#resumeSeries'), () => {
    state.playback.season = resumeTarget.season;
    state.playback.episode = resumeTarget.episode;
    openPlayerForCurrentSelection();
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
  document.querySelectorAll('[data-episode]').forEach((button) => button.addEventListener('click', () => {
    state.playback.episode = positiveInteger(button.dataset.episode, 1);
    openPlayerForCurrentSelection();
  }));
}

function openPlayerModal(embedUrl) {
  if (state.playerOpening) return;
  state.playerOpening = true;
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
  modal.hidden = true;
  iframe.src = 'about:blank';
  document.body.classList.remove('player-active');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  syncRoute();
}

function openPlayerForCurrentSelection() {
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
      const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
      if (!response.ok) break;
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

async function searchImdbSuggestionsViaJina(query, typeFilter) {
  const normalized = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const response = await fetch(`https://r.jina.ai/http://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(normalized)}.json`);
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

async function loadSeriesEpisodes() {
  if (!state.selected || !isSeriesLike(state.selected)) return;
  state.seriesEpisodesLoading = true;
  try {
    const imdbId = state.selected.imdbId || '';
    if (!imdbId) throw new Error('missing imdb id');

    const cached = loadCachedSeriesEpisodes(imdbId);
    if (cached?.seasons?.length) {
      state.seriesEpisodes = cached;
      state.seriesEpisodesLoading = false;
      return;
    }

    const text = await fetchEpisodeIdListText();
    state.seriesEpisodes = buildEpisodesFromIdList(imdbId, text);
    if ((state.seriesEpisodes?.seasons?.length ?? 0) > 0) {
      cacheSeriesEpisodes(imdbId, state.seriesEpisodes);
    }
  } catch {
    state.seriesEpisodes = { seasons: [] };
  } finally {
    state.seriesEpisodesLoading = false;
  }
}

async function fetchEpisodeIdListText() {
  const direct = await fetch('https://vidapi.ru/ids/eps_list_imdb.txt', { headers: { accept: 'text/plain' } }).catch(() => null);
  if (direct?.ok) return direct.text();

  const proxy = await fetch('https://r.jina.ai/http://vidapi.ru/ids/eps_list_imdb.txt').catch(() => null);
  if (!proxy?.ok) throw new Error('episodes list unavailable');
  const raw = await proxy.text();
  return normalizeJinaPayload(raw);
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
      const text = await fetchEpisodeIdListText();
      const set = new Set();
      for (const line of String(text || '').split('\n')) {
        const value = line.trim();
        if (!value.startsWith('tt')) continue;
        const sep = value.indexOf('_');
        if (sep <= 2) continue;
        const id = value.slice(0, sep);
        if (id.startsWith('tt')) set.add(id);
      }
      return set;
    } catch {
      return new Set();
    }
  })();

  return episodeIndexPromise;
}

function normalizeJinaPayload(text) {
  const lines = String(text ?? '').split('\n');
  const startIndex = lines.findIndex((line) => /^tt\d+_\d+x\d+/.test(line.trim()));
  if (startIndex === -1) return String(text ?? '');
  return lines.slice(startIndex).join('\n');
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

function loadLocalCatalog() {
  try { return JSON.parse(localStorage.getItem('mep_static_catalog') || '[]'); } catch { return []; }
}
function saveLocalCatalog(items) { localStorage.setItem('mep_static_catalog', JSON.stringify(items)); }

function cacheSearchResults(results) {
  const current = loadLocalCatalog();
  const merged = dedupe([...current, ...results]);
  saveLocalCatalog(merged);
}

function dedupe(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = `${item.type}:${item.imdbId || ''}:${item.tmdbId || ''}:${item.season || ''}:${item.episode || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}
function mergeAndRankResults(localResults, remoteResults, query) {
  return sortByRelevance(dedupe([...localResults.map((title) => ({ ...title, source: 'local' })), ...remoteResults.map((title) => ({ ...title, source: 'remote' }))]), query)
    .map((title) => ({ source: title.source || 'remote', title }));
}
function sortByRelevance(items, query) { const q = query.toLowerCase(); return [...items].sort((a, b) => relevanceScore(b, q) - relevanceScore(a, q)); }
function relevanceScore(item, query) { const t = (item.title || '').toLowerCase(); let s = 0; if (t === query) s += 200; if (t.startsWith(query)) s += 120; if (t.includes(query)) s += 80; if (item.type === 'series') s += 8; if (item.posterUrl) s += 5; return s; }

function normalizeSelection(remote) {
  const id = remote.imdbId || remote.tmdbId;
  return { catalogKey: `${remote.type}:${remote.imdbId ? 'imdb' : 'tmdb'}:${id}`, ...remote };
}
function buildEmbedUrl(entry) { const id = entry.imdbId || entry.tmdbId; return entry.type === 'movie' ? `https://vaplayer.ru/embed/movie/${encodeURIComponent(id)}` : `https://vaplayer.ru/embed/tv/${encodeURIComponent(id)}/${entry.season || 1}/${entry.episode || 1}`; }
function isSeriesLike(title) { return title.type === 'series' || title.type === 'episode'; }
function getCurrentEmbedUrl(baseEmbed) { if (!isSeriesLike(state.selected)) return baseEmbed; const id = state.selected.imdbId || state.selected.tmdbId; return `https://vaplayer.ru/embed/tv/${encodeURIComponent(id)}/${state.playback.season}/${state.playback.episode}`; }
function getEpisodesForSeason(seasonNumber) { const season = (state.seriesEpisodes?.seasons ?? []).find((entry) => entry.seasonNumber === seasonNumber); return season?.episodes ?? []; }
function positiveInteger(value, fallback) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; }
function syncTabs(type) { elements.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.typeTab === type)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function persistLastSelection() {
  if (!state.selected) return;
  localStorage.setItem('mep_last_selection', JSON.stringify({ imdbId: state.selected.imdbId || '', tmdbId: state.selected.tmdbId || '', season: state.playback.season, episode: state.playback.episode }));
}
function getSeriesProgress(title) { try { return JSON.parse(localStorage.getItem(`mep_series_progress_${title.imdbId || title.tmdbId}`) || '{"watched":{}}'); } catch { return { watched: {} }; } }
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
function isEpisodeWatched(progress, season, episode) { return Boolean(progress?.watched?.[`s${season}e${episode}`]); }
function getNextEpisodeTarget(progress, seriesEpisodes) {
  const seasons = seriesEpisodes?.seasons ?? [];
  if (!seasons.length) return null;
  const lastSeason = positiveInteger(progress?.lastSeason, seasons[0].seasonNumber);
  const lastEpisode = positiveInteger(progress?.lastEpisode, 0);
  const nextInSeason = (seasons.find((s) => s.seasonNumber === lastSeason)?.episodes ?? []).find((ep) => ep.episode > lastEpisode);
  if (nextInSeason) return { season: lastSeason, episode: nextInSeason.episode };
  const nextSeason = seasons.find((s) => s.seasonNumber > lastSeason && s.episodes.length > 0);
  if (nextSeason) return { season: nextSeason.seasonNumber, episode: nextSeason.episodes[0].episode };
  return { season: seasons[0].seasonNumber, episode: seasons[0].episodes[0]?.episode ?? 1 };
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
  if (!data || !['playing', 'paused', 'seeked', 'completed'].includes(data.player_status)) return;
  const info = data.player_info || {};
  const id = info.imdb || info.tmdb || state.selected?.imdbId || state.selected?.tmdbId;
  if (!id) return;
  const snapshot = { imdbId: info.imdb || state.selected?.imdbId || '', tmdbId: info.tmdb || state.selected?.tmdbId || '', season: Number(info.season || state.playback.season || 1), episode: Number(info.episode || state.playback.episode || 1), progress: Number(data.player_progress || 0) };
  localStorage.setItem('mep_last_watch', JSON.stringify(snapshot));
  const key = `mep_series_progress_${snapshot.imdbId || snapshot.tmdbId}`;
  const existing = JSON.parse(localStorage.getItem(key) || '{"watched":{}}');
  const watched = existing.watched || {};
  if (snapshot.progress > 60 || data.player_status === 'completed') watched[`s${snapshot.season}e${snapshot.episode}`] = true;
  localStorage.setItem(key, JSON.stringify({ ...existing, lastSeason: snapshot.season, lastEpisode: snapshot.episode, watched }));
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
      <button class="player-nav" data-player-action="back">Volver a la serie</button>
      <button class="player-nav" data-player-action="prev">Capítulo anterior</button>
      <button class="player-nav" data-player-action="next">Siguiente capítulo</button>
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
      state.selected = fromLocal || normalizeSelection({
        imdbId: id.startsWith('tt') ? id : '',
        tmdbId: id.startsWith('tt') ? '' : id,
        title: fromLocal?.title || id,
        year: fromLocal?.year || null,
        type: media === 'movie' ? 'movie' : 'series',
        posterUrl: fromLocal?.posterUrl || '',
        description: fromLocal?.description || 'Cargado desde ruta'
      });
      state.playback.season = season;
      state.playback.episode = episode;
      state.seriesEpisodes = null;
      state.seriesEpisodesLoading = isSeriesLike(state.selected);
      renderDetail({ skipHydratePlayback: shouldOpenPlayer });
      if (shouldOpenPlayer) {
        // iOS Safari can be flaky about repainting fixed overlays immediately;
        // deferring a tick makes the modal+hash transition more reliable.
        const target = getCurrentEmbedUrl(buildEmbedUrl(state.selected));
        setTimeout(() => openPlayerModal(target), 0);
      }
      if (isSeriesLike(state.selected)) {
        await loadSeriesEpisodes();
        renderDetail({ skipHydratePlayback: shouldOpenPlayer });
      }
      renderCatalog();
      if (q.length >= 3) searchRemoteCatalog(q);
      if (!shouldOpenPlayer) closePlayerModal();
    } else {
      renderCatalog();
      if (q.length >= 3) await searchRemoteCatalog(q);
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
