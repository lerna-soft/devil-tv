const state = {
  selected: null,
  remoteResults: [],
  remoteSearchTimer: null,
  lastRemoteQuery: '',
  playback: {
    season: 1,
    episode: 1
  }
};

const elements = {
  search: document.querySelector('#search'),
  typeFilter: document.querySelector('#typeFilter'),
  tabs: document.querySelectorAll('[data-type-tab]'),
  items: document.querySelector('#items'),
  count: document.querySelector('#count'),
  detail: document.querySelector('#detail')
};

elements.search.addEventListener('input', scheduleRemoteSearch);
elements.typeFilter.addEventListener('change', () => {
  syncTabs(elements.typeFilter.value);
  scheduleRemoteSearch();
});
elements.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    elements.typeFilter.value = tab.dataset.typeTab;
    syncTabs(tab.dataset.typeTab);
    scheduleRemoteSearch();
  });
});

renderInitialState();

function renderInitialState() {
  elements.items.innerHTML = '<div class="empty">Search for a title to begin.</div>';
  elements.count.textContent = '0 items';
}

function scheduleRemoteSearch() {
  clearTimeout(state.remoteSearchTimer);
  const query = elements.search.value.trim();

  if (query.length < 3) {
    renderInitialState();
    return;
  }

  elements.items.innerHTML = `
    <div class="loader-card">
      <span class="spinner"></span>
      <strong>Searching IMDb/TMDB</strong>
      <p>Looking for playable titles...</p>
    </div>
  `;
  elements.count.textContent = 'Searching...';

  state.remoteSearchTimer = setTimeout(() => {
    const normalized = query.toLowerCase();
    if (state.lastRemoteQuery === normalized) return;
    state.lastRemoteQuery = normalized;
    searchRemoteCatalog(query);
  }, 450);
}

async function searchRemoteCatalog(query) {
  try {
    const { items: providerResults, limited } = await searchVidapiListings(query, elements.typeFilter.value);
    let combined = providerResults;

    // Fallback for older titles not present in "latest" listings or when provider rate-limits.
    if (providerResults.length < 5 || limited) {
      const imdbFallback = await searchImdbSuggestionsViaJina(query, elements.typeFilter.value);
      combined = dedupe([...providerResults, ...imdbFallback]);
    }

    const playableResults = await filterPlayable(combined);
    state.remoteResults = playableResults;
    renderRemoteResults(query, { limited });
  } catch (error) {
    elements.items.innerHTML = `<div class="empty error">Search failed: ${escapeHtml(error.message)}</div>`;
    elements.count.textContent = '0 items';
  }
}

async function searchVidapiListings(query, typeFilter) {
  const normalizedQuery = query.trim().toLowerCase();
  const kinds = resolveKinds(typeFilter);
  const results = [];
  let limited = false;

  for (const kind of kinds) {
    const maxPages = kind === 'episode' ? 20 : 80;
    const found = await searchKind(kind, normalizedQuery, maxPages);
    if (found.limited) limited = true;
    results.push(...found);
  }

  return { items: dedupe(results), limited };
}

function resolveKinds(typeFilter) {
  if (typeFilter === 'movie') return ['movie'];
  if (typeFilter === 'series') return ['series'];
  if (typeFilter === 'episode') return ['episode'];
  return ['movie', 'series'];
}

async function searchKind(kind, query, maxPages) {
  const matches = [];
  let limited = false;

  for (let page = 1; page <= maxPages; page++) {
    const payload = await fetchVidapiPage(kind, page);
    if (payload.limited) {
      limited = true;
      break;
    }
    const items = payload.items ?? [];

    for (const item of items) {
      const normalized = normalizeVidapiItem(kind, item);
      if (!normalized) continue;
      const haystack = [
        normalized.title,
        normalized.description,
        normalized.imdbId,
        normalized.tmdbId
      ].join(' ').toLowerCase();
      if (haystack.includes(query)) matches.push(normalized);
    }

    if (matches.length >= 60) break;
    if (page >= Number(payload.total_pages ?? page)) break;
    await sleep(120);
  }

  matches.limited = limited;
  return matches;
}

async function fetchVidapiPage(kind, page) {
  const endpoint = kind === 'movie'
    ? `https://vidapi.ru/movies/latest/page-${page}.json`
    : kind === 'series'
      ? `https://vidapi.ru/tvshows/latest/page-${page}.json`
      : `https://vidapi.ru/episodes/latest/page-${page}.json`;

  const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
  if (response.status === 429) {
    return { limited: true, items: [] };
  }

  if (!response.ok) throw new Error(`VidAPI ${kind} request failed with HTTP ${response.status}`);

  return response.json();
}

async function searchImdbSuggestionsViaJina(query, typeFilter) {
  const normalized = query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const url = `https://r.jina.ai/http://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(normalized)}.json`;
  const response = await fetch(url);
  if (!response.ok) return [];

  const text = await response.text();
  const start = text.indexOf('{');
  if (start === -1) return [];

  let payload;
  try {
    payload = JSON.parse(text.slice(start));
  } catch {
    return [];
  }

  const mapped = (payload.d ?? [])
    .filter((item) => item.id?.startsWith('tt'))
    .map((item) => ({
      provider: 'imdb-jina-fallback',
      imdbId: item.id,
      tmdbId: '',
      title: item.l ?? '',
      year: Number.isInteger(Number(item.y)) ? Number(item.y) : null,
      type: item.qid === 'tvSeries' || item.q === 'TV series' ? 'series' : 'movie',
      posterUrl: item.i?.imageUrl ?? '',
      description: item.s ?? ''
    }));

  return filterByType(mapped, typeFilter);
}

function filterByType(results, type) {
  if (type === 'all') return results;
  return results.filter((result) => result.type === type);
}

function normalizeVidapiItem(kind, item) {
  if (kind === 'movie') {
    return {
      provider: 'vidapi',
      imdbId: item.imdb_id ?? '',
      tmdbId: item.tmdb_id === null || item.tmdb_id === undefined ? '' : String(item.tmdb_id),
      title: item.title ?? '',
      year: Number.isInteger(Number(item.year)) ? Number(item.year) : null,
      type: 'movie',
      posterUrl: item.poster_url ?? '',
      description: item.genre ?? ''
    };
  }

  if (kind === 'series') {
    return {
      provider: 'vidapi',
      imdbId: item.imdb_id ?? '',
      tmdbId: item.tmdb_id === null || item.tmdb_id === undefined ? '' : String(item.tmdb_id),
      title: item.title ?? '',
      year: Number.isInteger(Number(item.year)) ? Number(item.year) : null,
      type: 'series',
      posterUrl: item.poster_url ?? '',
      description: item.genre ?? ''
    };
  }

  return {
    provider: 'vidapi',
    imdbId: item.show_imdb_id ?? '',
    tmdbId: item.show_tmdb_id === null || item.show_tmdb_id === undefined ? '' : String(item.show_tmdb_id),
    title: item.episode_title ?? '',
    showTitle: item.show_title ?? '',
    year: item.air_date ? Number(String(item.air_date).slice(0, 4)) : null,
    type: 'episode',
    posterUrl: '',
    season: Number(item.season_number) || 1,
    episode: Number(item.episode_number) || 1,
    description: `${item.show_title ?? 'Series'} S${item.season_number}E${item.episode_number}`
  };
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

async function filterPlayable(results) {
  const playable = [];

  for (const result of results) {
    const embedUrl = buildEmbedUrl(result);
    if (!embedUrl) continue;
    if (await isPlayable(embedUrl)) {
      playable.push({
        ...result,
        embedUrl
      });
    }
  }

  return playable;
}

async function isPlayable(embedUrl) {
  try {
    const head = await fetch(embedUrl, { method: 'HEAD', redirect: 'follow' });
    if (head.status !== 405) return head.ok && head.status !== 404;
  } catch {
    // ignore and try GET
  }

  try {
    const get = await fetch(embedUrl, { method: 'GET', redirect: 'follow' });
    return get.ok && get.status !== 404;
  } catch {
    return false;
  }
}

function renderRemoteResults(query, options = {}) {
  const limited = Boolean(options.limited);
  const cards = state.remoteResults
    .map((title, index) => {
      const poster = title.posterUrl;
      return `
        <article class="item" data-remote-index="${index}">
          ${poster ? `<img class="item-poster" src="${escapeAttribute(poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="item-poster placeholder"></div>'}
          <div>
            <strong>${escapeHtml(title.title)}</strong>
            <span class="meta">${escapeHtml(title.type)} | IMDb: ${escapeHtml(title.imdbId || '-')} | ${escapeHtml(title.year ?? '')}</span>
            <span class="meta">${escapeHtml(title.description || 'Remote IMDb result')}</span>
          </div>
        </article>
      `;
    })
    .join('');

  elements.items.innerHTML = cards || '<div class="empty">No playable results found for this query.</div>';
  elements.count.textContent = `${state.remoteResults.length} matches for "${query}"${limited ? ' (provider rate-limited)' : ''}`;

  elements.items.querySelectorAll('[data-remote-index]').forEach((item) => {
    item.addEventListener('click', () => {
      state.selected = normalizeSelection(state.remoteResults[Number(item.dataset.remoteIndex)]);
      renderRemoteResults(elements.search.value.trim());
      renderDetail();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSelection(remote) {
  const id = remote.imdbId || remote.tmdbId;
  const embedUrl = remote.embedUrl || buildEmbedUrl(remote);
  return {
    catalogKey: `${remote.type}:${remote.imdbId ? 'imdb' : 'tmdb'}:${id}`,
    type: remote.type,
    imdbId: remote.imdbId || '',
    tmdbId: remote.tmdbId || '',
    title: remote.title,
    showTitle: remote.showTitle || '',
    year: remote.year,
    season: remote.season || 1,
    episode: remote.episode || 1,
    description: remote.description,
    posterUrl: remote.posterUrl,
    metadata: {
      provider: remote.provider,
      posterUrl: remote.posterUrl
    },
    externalPages: [{ label: 'vidapi', url: embedUrl }]
  };
}

function renderDetail() {
  const title = state.selected;
  if (!title) {
    elements.detail.innerHTML = '<div class="empty">Search and select a title to preview.</div>';
    return;
  }

  const baseEmbed = title.externalPages?.[0]?.url ?? buildEmbedUrl(title);
  state.playback.season = title.season || state.playback.season || 1;
  state.playback.episode = title.episode || state.playback.episode || 1;
  const poster = title.posterUrl;
  const categories = 'Streaming lookup';

  elements.detail.innerHTML = `
    <div class="detail-inner">
      <section class="title-hero" style="${poster ? `--poster: url('${escapeAttribute(poster)}')` : ''}">
        <div class="title-copy">
          <span class="pill">${escapeHtml(title.type)}</span>
          <h2>${escapeHtml(title.title)}</h2>
          <p class="title-meta">${escapeHtml([title.year, categories].filter(Boolean).join('  |  '))}</p>
          <p class="title-description">${escapeHtml(title.description || 'Search result loaded on demand. No local persistence enabled.')}</p>
          <div class="id-row">
            <span>IMDb: ${escapeHtml(title.imdbId || '-')}</span>
            <span>TMDB: ${escapeHtml(title.tmdbId || '-')}</span>
          </div>
          <div class="actions hero-actions">
            <button id="loadPlayer">Play</button>
          </div>
        </div>
      </section>

      <div class="player player-standby" id="playerBox">
        <div>
          <strong>Ready to play</strong>
          <p>Review the title information first. Press Play to load the VidAPI iframe.</p>
        </div>
      </div>

      <div class="form-grid">
        ${isSeriesLike(title) ? `
          <label>
            Season
            <input id="seasonInput" type="number" min="1" value="${escapeAttribute(state.playback.season)}" />
          </label>
          <label>
            Episode
            <input id="episodeInput" type="number" min="1" value="${escapeAttribute(state.playback.episode)}" />
          </label>
        ` : ''}
        <label class="wide">
          Subtitle URL (.srt/.vtt)
          <input id="subUrl" placeholder="https://example.com/subtitles/movie.srt" />
        </label>
        <label>
          Label
          <input id="subLabel" placeholder="Spanish" />
        </label>
        <label>
          Language
          <input id="subLang" placeholder="es" />
        </label>
        <label>
          Subtitle language
          <select id="dsLang">
            <option value="">Auto</option>
            <option value="en">English</option>
            <option value="es">Spanish</option>
            <option value="ja">Japanese</option>
            <option value="pt">Portuguese</option>
            <option value="fr">French</option>
            <option value="de">German</option>
            <option value="it">Italian</option>
          </select>
        </label>
        <label>
          Resume at seconds
          <input id="resumeAt" type="number" min="0" placeholder="300" />
        </label>
      </div>

      <div class="actions">
        <button id="applyParams">Apply Player Params</button>
      </div>

      <div class="notice">
        Current embed:<br />
        <code id="embedUrl">${escapeHtml(baseEmbed)}</code>
      </div>
    </div>
  `;

  document.querySelector('#applyParams').addEventListener('click', () => applyPlayerParams(baseEmbed));
  document.querySelector('#loadPlayer').addEventListener('click', () => loadPlayer(getCurrentEmbedUrl(baseEmbed)));
  document.querySelector('#seasonInput')?.addEventListener('change', updateEpisodeState);
  document.querySelector('#episodeInput')?.addEventListener('change', updateEpisodeState);
}

function loadPlayer(embedUrl) {
  document.querySelector('#playerBox').classList.remove('player-standby');
  document.querySelector('#playerBox').innerHTML = `
    <iframe
      id="player"
      src="${escapeAttribute(embedUrl)}"
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
      sandbox="allow-scripts allow-same-origin allow-presentation"
      referrerpolicy="strict-origin-when-cross-origin"
      allowfullscreen
    ></iframe>
  `;
}

function applyPlayerParams(baseEmbed) {
  const url = new URL(getCurrentEmbedUrl(baseEmbed));
  const params = {
    sub_url: document.querySelector('#subUrl')?.value,
    sub_label: document.querySelector('#subLabel')?.value,
    sub_lang: document.querySelector('#subLang')?.value,
    ds_lang: document.querySelector('#dsLang')?.value,
    resumeAt: document.querySelector('#resumeAt')?.value
  };

  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  if (!document.querySelector('#player')) {
    loadPlayer(url.toString());
  } else {
    document.querySelector('#player').src = url.toString();
  }
  document.querySelector('#embedUrl').textContent = url.toString();
}

function buildEmbedUrl(entry) {
  const id = entry.imdbId || entry.tmdbId;
  if (!id) return '';
  if (entry.type === 'movie') return `https://vaplayer.ru/embed/movie/${encodeURIComponent(id)}`;
  if (entry.type === 'episode' || entry.type === 'series') {
    const season = entry.season || 1;
    const episode = entry.episode || 1;
    return `https://vaplayer.ru/embed/tv/${encodeURIComponent(id)}/${season}/${episode}`;
  }
  return `https://vaplayer.ru/embed/tv/${encodeURIComponent(id)}`;
}

function isSeriesLike(title) {
  return title.type === 'series' || title.type === 'episode';
}

function updateEpisodeState() {
  state.playback.season = positiveInteger(document.querySelector('#seasonInput')?.value, 1);
  state.playback.episode = positiveInteger(document.querySelector('#episodeInput')?.value, 1);
  const embedUrl = getCurrentEmbedUrl(buildEmbedUrl(state.selected));
  document.querySelector('#embedUrl').textContent = embedUrl;
}

function getCurrentEmbedUrl(baseEmbed) {
  if (!isSeriesLike(state.selected)) return baseEmbed;
  const id = state.selected.imdbId || state.selected.tmdbId;
  const season = positiveInteger(document.querySelector('#seasonInput')?.value ?? state.playback.season, 1);
  const episode = positiveInteger(document.querySelector('#episodeInput')?.value ?? state.playback.episode, 1);
  state.playback.season = season;
  state.playback.episode = episode;
  return `https://vaplayer.ru/embed/tv/${encodeURIComponent(id)}/${season}/${episode}`;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function syncTabs(type) {
  elements.tabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.typeTab === type);
  });
}

window.addEventListener('message', (event) => {
  if (event.data?.type !== 'PLAYER_EVENT') return;
  if (event.data.data?.player_status !== 'completed') return;
  if (!isSeriesLike(state.selected)) return;

  state.playback.episode += 1;
  const episodeInput = document.querySelector('#episodeInput');
  if (episodeInput) episodeInput.value = state.playback.episode;
  const nextUrl = getCurrentEmbedUrl(buildEmbedUrl(state.selected));
  loadPlayer(nextUrl);
  document.querySelector('#embedUrl').textContent = nextUrl;
});

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
