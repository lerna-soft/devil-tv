# Devil TV — Password Recovery Worker

Cloudflare Worker que commitea cambios de contraseña al repo
`lerna-soft/devil-tv` via GitHub API. Es el único componente del flujo
de recuperación que puede escribir al repositorio (la página
`reset.html` y la UI de cambio de contraseña no pueden tener un PAT
expuesto en el cliente, por eso delegan al Worker).

## Endpoints

### `POST /reset-password`
Llamado por `reset.html` después de validar un `resetToken`.

```json
{
  "email": "usuario@ejemplo.com",
  "token": "<64 hex chars del resetToken>",
  "newSalt": "mep_auth_salt_v1_<16 hex>",
  "newHash": "<64 hex sha256>"
}
```

Valida que el token coincida y no haya expirado. Si OK, commitea
`salt` + `passwordHash` nuevos y limpia los campos de reset.

### `POST /change-password`
Llamado por la UI de cambio de contraseña (usuario autenticado que
quiere cambiar su pw, sin reset por correo).

```json
{
  "email": "usuario@ejemplo.com",
  "currentHash": "<64 hex sha256 de la contraseña actual con el salt actual>",
  "newSalt": "mep_auth_salt_v1_<16 hex>",
  "newHash": "<64 hex sha256>"
}
```

El cliente computa el hash de la contraseña actual usando el `salt`
que ya conoce del JSON del user. El Worker compara hash contra hash,
nunca recibe la contraseña en plano.

### `POST /create-issue`
Crea un issue en `lerna-soft/devil-tv` usando el PAT del Worker.
Lo usan `app.js` para reportes de usuario, role-provision, metadata
request, watch-progress sync, etc. Antes esto se hacía con un PAT
ofuscado en el cliente, pero después del transfer del repo de
`lerna-admin` a `lerna-soft` ese PAT quedó sin scope.

```json
{
  "title": "User report: ...",
  "body": "<markdown>",
  "labels": ["user-report"]
}
```

Crea labels que no existan (best-effort, color genérico). Devuelve
`{ ok: true, number, html_url }`.

### `GET /subs?imdb=tt..&lang=es[&season=N&episode=N]`
Fetcha subtítulos de OpenSubtitles (legacy REST sin auth), descomprime
el `.srt.gz` y convierte a `.vtt` antes de servir. Cache 7 días en
Cloudflare edge.

Diseñado para players de embed que aceptan `?sub_file={URL}` (vidlink,
2embed, superembed). El response tiene `Access-Control-Allow-Origin: *`
porque el iframe que lo lee está en otro origin.

Si no hay subs disponibles para ese título/idioma, devuelve un VTT
vacío válido (`WEBVTT\n\n`) — los players lo manejan como "subs no
disponibles" sin romper la reproducción.

---

## Variables y secrets (configurar en Cloudflare)

| Nombre | Tipo | Valor |
|---|---|---|
| `GITHUB_REPO` | Variable (plain) | `lerna-soft/devil-tv` |
| `ALLOWED_ORIGIN` | Variable (plain) | `https://lerna-soft.github.io` |
| `GITHUB_PAT` | **Secret** | Fine-grained PAT con `contents:write` en `lerna-soft/devil-tv` |

---

## Deploy desde el dashboard de Cloudflare (UI)

1. <https://dash.cloudflare.com/> → menú izquierda → **Workers & Pages**.
2. Click **Create** → **Workers** → **Create Worker**.
3. Nombre: `devil-tv-recovery`. Click **Deploy** (con código default).
4. Click **Edit code**.
5. Borrar todo y pegar el contenido de `index.js` (este directorio).
6. Click **Deploy** (arriba derecha).
7. Click **← devil-tv-recovery** para volver al detalle del Worker.
8. Pestaña **Settings** → **Variables and Secrets**:
   - Add variable: `GITHUB_REPO` = `lerna-soft/devil-tv`
   - Add variable: `ALLOWED_ORIGIN` = `https://lerna-soft.github.io`
   - Add **secret**: `GITHUB_PAT` = el PAT generado en GitHub
9. La URL final es algo como `https://devil-tv-recovery.<tu-subdomain>.workers.dev`.
   Copiarla y configurarla en:
   - `reset.html` → constante `RESET_WORKER_URL`
   - `app.js` → constante `RESET_WORKER_URL` (cuando se implemente pieza 6)

## Deploy desde CLI (alternativa, requiere wrangler)

```bash
cd worker
npx wrangler login
npx wrangler secret put GITHUB_PAT  # pegar PAT cuando lo pida
npx wrangler deploy
```
