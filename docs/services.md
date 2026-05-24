# Servicios externos

Este documento registra qué cuentas y servicios de terceros usa el proyecto, bajo qué identidad están creadas, y dónde viven los secrets correspondientes. Aquí **no** se guardan tokens ni API keys — solo el lugar/cuenta donde existen.

## Resend (envío de correo transaccional)

- **Propósito**: enviar correos del flujo de recuperación de contraseña (link de reset enviado al usuario).
- **Cuenta**: `hglerna@gmail.com`
- **Dashboard**: <https://resend.com>
- **Plan**: Free tier (3.000 correos/mes, 100/día). Sin tarjeta.
- **API key**: configurada como secret `RESEND_API_KEY` en el repo `lerna-soft/devil-tv` (GitHub Actions). Para rotarla, generar nueva en el dashboard de Resend y reemplazar el secret con `gh secret set RESEND_API_KEY --repo lerna-soft/devil-tv`.
- **Dominio remitente**: por definir. Hoy se usa `onboarding@resend.dev` (default de Resend, no requiere verificación de dominio).
- **Usado por**: `.github/workflows/password-reset.yml`.
