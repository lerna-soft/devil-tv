# Servicios externos

Este documento registra qué cuentas y servicios de terceros usa el proyecto, bajo qué identidad están creadas, y dónde viven los secrets correspondientes. Aquí **no** se guardan tokens ni API keys — solo el lugar/cuenta donde existen.

## Brevo (envío de correo transaccional)

- **Propósito**: enviar correos del flujo de recuperación de contraseña (link de reset enviado al usuario).
- **Cuenta**: `hglerna@gmail.com` (pendiente de confirmación final)
- **Dashboard**: <https://app.brevo.com>
- **Plan**: Free tier (300 correos/día perpetuo, sin tarjeta de crédito).
- **API key**: configurada como secret `BREVO_API_KEY` en el repo `lerna-soft/devil-tv` (GitHub Actions). Para rotarla, generar nueva en <https://app.brevo.com/settings/keys/api> y reemplazar el secret con `gh secret set BREVO_API_KEY --repo lerna-soft/devil-tv`.
- **Sender verificado**: `hglerna@gmail.com` (nombre: "Devil TV"). Sin dominio verificado, los correos llevan footer "Sent via Brevo" hasta agregar dominio propio.
- **Usado por**: `.github/workflows/password-reset.yml`.

## Cloudflare Workers (recovery worker)

- **Propósito**: backend mínimo (~200 líneas) que commitea cambios de contraseña al repo via GitHub API. Necesario porque ni `reset.html` ni `app.js` pueden tener un PAT expuesto en el cliente.
- **Cuenta**: `hglerna@gmail.com`
- **Dashboard**: <https://dash.cloudflare.com/> → Workers & Pages
- **Plan**: Workers Free (100.000 requests/día perpetuo, sin tarjeta).
- **Worker name**: `devil-tv-recovery`
- **Código fuente**: [`worker/`](../worker/) en este repo.
- **Variables/Secrets configurados en Cloudflare**:
  - `GITHUB_REPO` (variable, plain) = `lerna-soft/devil-tv`
  - `ALLOWED_ORIGIN` (variable, plain) = `https://lerna-soft.github.io`
  - `GITHUB_PAT` (**secret**) = PAT fine-grained con `contents:write` en `lerna-soft/devil-tv`. Para rotarlo: revocar en GitHub → generar nuevo → reemplazar el secret en Cloudflare (dashboard del Worker → Settings → Variables → editar `GITHUB_PAT`).

## GitHub PAT (usado por el Worker)

- **Token name**: `devil-tv-worker-reset`
- **Tipo**: fine-grained PAT
- **Scope**: solo repo `lerna-soft/devil-tv`, permiso `Contents: Read and write` únicamente.
- **Dónde vive**: como secret `GITHUB_PAT` en el Worker `devil-tv-recovery` (Cloudflare). NO en este repo.
- **Auditoría**: cada commit del Worker queda registrado como hecho por `lerna-admin` usando este PAT. Última vez usado visible en <https://github.com/settings/personal-access-tokens>.

## Notas históricas

- **Resend** se evaluó y descartó (mayo 2026). Razón: su free tier sin dominio verificado solo permite enviar al email de la cuenta; necesitaríamos comprar dominio (~$12/año) para enviar a usuarios reales. Brevo no tiene esta restricción.
