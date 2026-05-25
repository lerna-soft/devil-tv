// Devil TV — password recovery Worker
// Cloudflare Worker que commitea cambios de contraseña al repo
// lerna-soft/devil-tv via GitHub API. Vive en *.workers.dev.
//
// Endpoints:
//   POST /reset-password   { email, token, newSalt, newHash }
//   POST /change-password  { email, currentHash, newSalt, newHash }
//   POST /create-issue     { title, body, labels[] }
//   GET  /subs?imdb=tt..&lang=es[&season=N&episode=N]
//         Fetcha subs de OpenSubtitles, convierte .srt → .vtt, sirve con
//         CORS abierto. Para inyectar subs ES en players que aceptan
//         sub_file (vidlink, 2embed, superembed).
//
// Secrets/vars requeridos (configurar en Cloudflare dashboard):
//   GITHUB_PAT  — fine-grained PAT con contents:write en lerna-soft/devil-tv
//   GITHUB_REPO — string "lerna-soft/devil-tv"
//   ALLOWED_ORIGIN — "https://lerna-soft.github.io"

const GITHUB_API = 'https://api.github.com';

function jsonResponse(status, body, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env)
    }
  });
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env?.ALLOWED_ORIGIN || 'https://lerna-soft.github.io',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function isValidHex(s, len) {
  return typeof s === 'string' && s.length === len && /^[a-f0-9]+$/i.test(s);
}

function isValidSalt(s) {
  return typeof s === 'string' && s.startsWith('mep_auth_salt_v1_') && s.length >= 30;
}

async function fetchUserFile(email, env) {
  const filePath = `assets/users/${email}.json`;
  const resp = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/${encodeURIComponent(filePath)}`,
    {
      headers: {
        'Authorization': `Bearer ${env.GITHUB_PAT}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'devil-tv-recovery-worker'
      }
    }
  );
  if (resp.status === 404) return { notFound: true };
  if (!resp.ok) return { error: `GitHub GET failed: ${resp.status}` };
  const data = await resp.json();
  let content;
  try {
    const raw = atob((data.content || '').replace(/\s/g, ''));
    content = JSON.parse(raw);
  } catch {
    return { error: 'User JSON corrupted' };
  }
  return { sha: data.sha, content, filePath };
}

async function commitUserFile({ filePath, sha, newContent, message, env }) {
  const encoded = btoa(unescape(encodeURIComponent(newContent)));
  const resp = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/${encodeURIComponent(filePath)}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_PAT}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'devil-tv-recovery-worker'
      },
      body: JSON.stringify({ message, content: encoded, sha })
    }
  );
  if (!resp.ok) {
    const txt = await resp.text();
    return { error: `GitHub PUT failed: ${resp.status} ${txt.substring(0, 200)}` };
  }
  return { ok: true };
}

async function handleResetPassword(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON' }, env);
  }

  const { email, token, newSalt, newHash } = body || {};

  if (!isValidEmail(email)) return jsonResponse(400, { error: 'Email no válido' }, env);
  if (!isValidHex(token, 64)) return jsonResponse(400, { error: 'Token inválido' }, env);
  if (!isValidSalt(newSalt)) return jsonResponse(400, { error: 'Salt inválido' }, env);
  if (!isValidHex(newHash, 64)) return jsonResponse(400, { error: 'Hash inválido' }, env);

  const normalizedEmail = email.trim().toLowerCase();
  const file = await fetchUserFile(normalizedEmail, env);
  if (file.notFound) return jsonResponse(404, { error: 'Usuario no encontrado' }, env);
  if (file.error) return jsonResponse(502, { error: file.error }, env);

  const user = file.content;

  if (!user.resetToken || user.resetToken !== token) {
    return jsonResponse(401, { error: 'Token inválido o ya usado' }, env);
  }
  const expiresAt = user.resetTokenExpiresAt ? Date.parse(user.resetTokenExpiresAt) : 0;
  if (!expiresAt || expiresAt < Date.now()) {
    return jsonResponse(401, { error: 'Token expirado. Solicita un nuevo reset.' }, env);
  }

  const updated = {
    ...user,
    salt: newSalt,
    passwordHash: newHash,
    mustChangePassword: false,
    resetToken: null,
    resetTokenExpiresAt: null
  };
  const newContent = JSON.stringify(updated, null, 2) + '\n';

  const result = await commitUserFile({
    filePath: file.filePath,
    sha: file.sha,
    newContent,
    message: 'auth: password reset completed',
    env
  });
  if (result.error) return jsonResponse(502, { error: result.error }, env);

  return jsonResponse(200, { ok: true }, env);
}

async function handleChangePassword(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON' }, env);
  }

  const { email, currentHash, newSalt, newHash } = body || {};

  if (!isValidEmail(email)) return jsonResponse(400, { error: 'Email no válido' }, env);
  if (!isValidHex(currentHash, 64)) return jsonResponse(400, { error: 'currentHash inválido' }, env);
  if (!isValidSalt(newSalt)) return jsonResponse(400, { error: 'Salt inválido' }, env);
  if (!isValidHex(newHash, 64)) return jsonResponse(400, { error: 'Hash inválido' }, env);

  const normalizedEmail = email.trim().toLowerCase();
  const file = await fetchUserFile(normalizedEmail, env);
  if (file.notFound) return jsonResponse(404, { error: 'Usuario no encontrado' }, env);
  if (file.error) return jsonResponse(502, { error: file.error }, env);

  const user = file.content;

  if (!user.passwordHash || user.passwordHash !== currentHash) {
    return jsonResponse(401, { error: 'Contraseña actual incorrecta' }, env);
  }

  const updated = {
    ...user,
    salt: newSalt,
    passwordHash: newHash,
    mustChangePassword: false,
    resetToken: null,
    resetTokenExpiresAt: null
  };
  const newContent = JSON.stringify(updated, null, 2) + '\n';

  const result = await commitUserFile({
    filePath: file.filePath,
    sha: file.sha,
    newContent,
    message: 'auth: password changed by user',
    env
  });
  if (result.error) return jsonResponse(502, { error: result.error }, env);

  return jsonResponse(200, { ok: true }, env);
}

async function handleValidateToken(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON' }, env);
  }

  const { email, token } = body || {};
  if (!isValidEmail(email)) return jsonResponse(400, { error: 'Email no válido' }, env);
  if (!isValidHex(token, 64)) return jsonResponse(400, { error: 'Token inválido' }, env);

  const normalizedEmail = email.trim().toLowerCase();
  const file = await fetchUserFile(normalizedEmail, env);
  if (file.notFound) return jsonResponse(404, { error: 'Usuario no encontrado' }, env);
  if (file.error) return jsonResponse(502, { error: file.error }, env);

  const user = file.content;
  if (!user.resetToken || user.resetToken !== token) {
    return jsonResponse(401, { error: 'Token inválido o ya usado', code: 'invalid' }, env);
  }
  const expiresAt = user.resetTokenExpiresAt ? Date.parse(user.resetTokenExpiresAt) : 0;
  if (!expiresAt || expiresAt < Date.now()) {
    return jsonResponse(401, { error: 'Token expirado. Solicita un nuevo reset.', code: 'expired' }, env);
  }

  return jsonResponse(200, { ok: true, expiresAt: user.resetTokenExpiresAt }, env);
}

async function handleRequestReset(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON' }, env);
  }

  const { email } = body || {};
  if (!isValidEmail(email)) return jsonResponse(400, { error: 'Email no válido' }, env);

  const normalizedEmail = email.trim().toLowerCase();

  // Ensure label exists (best effort)
  try {
    await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/labels`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_PAT}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'devil-tv-recovery-worker'
      },
      body: JSON.stringify({
        name: 'password-reset',
        color: 'd73a4a',
        description: 'Password reset request (procesado automáticamente)'
      })
    });
  } catch {
    // 422 if exists, ignored
  }

  const issueBody = `### Tu email\n\n${normalizedEmail}\n`;
  const resp = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_PAT}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'devil-tv-recovery-worker'
    },
    body: JSON.stringify({
      title: 'Password reset request',
      body: issueBody,
      labels: ['password-reset']
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    return jsonResponse(502, { error: `Issue create failed: ${resp.status} ${text.substring(0, 200)}` }, env);
  }

  return jsonResponse(200, { ok: true }, env);
}

async function handleCreateIssue(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'JSON inválido' }, env);
  }

  const title = String(body?.title || '').trim();
  const issueBody = String(body?.body || '').trim();
  const rawLabels = Array.isArray(body?.labels) ? body.labels : [];
  const labels = [...new Set(
    rawLabels.map((s) => String(s || '').trim()).filter(Boolean)
  )];

  if (!title) return jsonResponse(400, { error: 'title es requerido' }, env);
  if (title.length > 256) return jsonResponse(400, { error: 'title demasiado largo' }, env);
  if (issueBody.length > 65536) return jsonResponse(400, { error: 'body demasiado largo' }, env);

  // Best-effort: create labels that don't exist yet. Ignore 422 (already exists).
  await Promise.all(labels.map(async (name) => {
    try {
      await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/labels`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_PAT}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'devil-tv-recovery-worker'
        },
        body: JSON.stringify({ name, color: '5319E7', description: 'Auto-created label' })
      });
    } catch {
      // ignored
    }
  }));

  const resp = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_PAT}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'devil-tv-recovery-worker'
    },
    body: JSON.stringify({ title, body: issueBody, labels })
  });

  if (!resp.ok) {
    const text = await resp.text();
    return jsonResponse(502, { error: `Issue create failed: ${resp.status} ${text.substring(0, 200)}` }, env);
  }

  const data = await resp.json();
  return jsonResponse(200, { ok: true, number: data.number, html_url: data.html_url }, env);
}

const SUBS_LANG_MAP = { es: 'spa', en: 'eng', pt: 'por', fr: 'fre', it: 'ita', de: 'ger' };

function vttHeaders() {
  return {
    'Content-Type': 'text/vtt; charset=utf-8',
    // Wildcard porque el .vtt lo carga el iframe del provider (vidlink, etc.)
    // que está en otro origin. Sin esto, falla la lectura cross-origin.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'public, max-age=604800'
  };
}

function emptyVtt() {
  return new Response('WEBVTT\n\n', { status: 200, headers: vttHeaders() });
}

function srtToVtt(srt) {
  return 'WEBVTT\n\n' + String(srt || '')
    .replace(/\r\n/g, '\n')
    // SRT usa coma como separador de milisegundos; VTT usa punto.
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim() + '\n';
}

async function handleSubs(request) {
  const url = new URL(request.url);
  const imdb = String(url.searchParams.get('imdb') || '').trim();
  const lang = String(url.searchParams.get('lang') || 'es').toLowerCase();
  const season = String(url.searchParams.get('season') || '').trim();
  const episode = String(url.searchParams.get('episode') || '').trim();

  if (!/^tt\d+$/.test(imdb)) {
    return new Response('WEBVTT\n\nNOTE imdb param requerido (formato ttNNN)\n', {
      status: 200, headers: vttHeaders()
    });
  }

  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const numericId = imdb.replace(/^tt/, '');
  const sublang = SUBS_LANG_MAP[lang] || 'spa';

  const isTv = season && episode && /^\d+$/.test(season) && /^\d+$/.test(episode);
  const searchPath = isTv
    ? `/search/episode-${episode}/imdbid-${numericId}/season-${season}/sublanguageid-${sublang}`
    : `/search/imdbid-${numericId}/sublanguageid-${sublang}`;

  let subs;
  try {
    const searchResp = await fetch(`https://rest.opensubtitles.org${searchPath}`, {
      headers: { 'X-User-Agent': 'DevilTV v1' }
    });
    if (!searchResp.ok) return emptyVtt();
    subs = await searchResp.json();
  } catch {
    return emptyVtt();
  }

  const candidates = (Array.isArray(subs) ? subs : [])
    .filter((s) => s && s.SubLanguageID === sublang && s.SubFormat === 'srt' && s.SubHearingImpaired === '0')
    .sort((a, b) => Number(b.SubDownloadsCnt || 0) - Number(a.SubDownloadsCnt || 0));

  if (!candidates.length) return emptyVtt();

  const top = candidates[0];
  let srtText;
  try {
    const downloadResp = await fetch(top.SubDownloadLink, {
      headers: { 'X-User-Agent': 'DevilTV v1' }
    });
    if (!downloadResp.ok) return emptyVtt();
    // El archivo viene .srt.gz; descomprimir con DecompressionStream nativo.
    try {
      const stream = downloadResp.body.pipeThrough(new DecompressionStream('gzip'));
      srtText = await new Response(stream).text();
    } catch {
      srtText = await downloadResp.text();
    }
  } catch {
    return emptyVtt();
  }

  const vtt = srtToVtt(srtText);
  const response = new Response(vtt, { status: 200, headers: vttHeaders() });
  // Fire-and-forget cache write (sin esperar para no bloquear el response).
  caches.default.put(cacheKey, response.clone()).catch(() => {});
  return response;
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/request-reset') {
      return handleRequestReset(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/validate-token') {
      return handleValidateToken(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/reset-password') {
      return handleResetPassword(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/change-password') {
      return handleChangePassword(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/create-issue') {
      return handleCreateIssue(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/subs') {
      return handleSubs(request);
    }

    return jsonResponse(404, { error: 'Not found' }, env);
  }
};
