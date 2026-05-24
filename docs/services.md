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

## Notas históricas

- **Resend** se evaluó y descartó (mayo 2026). Razón: su free tier sin dominio verificado solo permite enviar al email de la cuenta; necesitaríamos comprar dominio (~$12/año) para enviar a usuarios reales. Brevo no tiene esta restricción.
