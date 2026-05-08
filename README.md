# Media Evaluation Platform Static

Versión frontend-only (sin backend) del proyecto de streaming de Lerna Soft.

Este repositorio está optimizado para correr en GitHub Pages y usar `localStorage` como capa de persistencia local (catálogo, progreso y cachés).

## Estado actual

- Repositorio: `lerna-admin/media-evaluation-platform-static`
- URL pública: `https://lerna-admin.github.io/media-evaluation-platform-static/`
- Publicación activa desde rama: `gh-pages`
- Rama de desarrollo: `main`
- Reproductor primario: VidAPI (`https://vaplayer.ru/embed/...`)
- Los episodios se publican como assets estáticos por serie:
  - `assets/episodes/index.json`
  - `assets/episodes/<imdbId>.txt`

## Assets de episodios

- El catálogo de episodios no se carga como un solo archivo grande en runtime.
- La app consulta un manifest liviano en `assets/episodes/index.json`.
- Cada serie tiene su propio archivo en `assets/episodes/<imdbId>.txt`.
- El generador está en [`tools/build-episode-assets.mjs`](/home/xanadu/media-evaluation-platform-static/tools/build-episode-assets.mjs).
- El pipeline de Pages sincroniza issues con label `episode-sync` antes de reconstruir episodios.
- El sincronizador está en [`tools/sync-episode-targets-from-issues.mjs`](/home/xanadu/media-evaluation-platform-static/tools/sync-episode-targets-from-issues.mjs).
- Después del deploy, el workflow cierra automáticamente los issues ya procesados para no reprocesarlos.
- Cada issue con label `episode-sync` también dispara un workflow dedicado que intenta resolverlo de inmediato y deja los assets actualizados en `main`.
- Los targets actuales están en [`assets/episodes/targets.json`](/home/xanadu/media-evaluation-platform-static/assets/episodes/targets.json).
- El workflow de Pages ejecuta ese script antes de publicar.
- Fuente usada para construir los assets: TVMaze.

## Estado por plataforma

### Mobile

- Flujo principal funcional:
  - búsqueda -> detalle -> watch fullscreen.
- En detalle se ocultan distracciones del fondo.
- En watch de series hay controles de navegación (volver, anterior, siguiente).
- Persistencia local de progreso/vistos funcional.
- Estado: usable para pruebas reales, con ajustes UX todavía iterables.

### Desktop

- Flujo funcional completo en navegación y reproducción.
- Rutas hash y restauración de estado operativas.
- Persistencia local y cache operativos.
- Estado: estable para uso de prueba.

## Funcionalidad implementada

- Búsqueda de títulos en fuentes públicas (VidAPI + fallback IMDb vía proxy web).
- Listado combinado con ranking de relevancia.
- Guardado incremental de resultados en `localStorage` para acelerar búsquedas futuras.
- Filtro para no listar series sin episodios disponibles.
- Vista de detalle tipo plataforma (en mobile, foco en detalle y sin distracciones del fondo).
- Rutas hash SPA:
  - `#/browse?...`
  - `#/title/<movie|series>/<id>?...`
  - `#/watch/<movie>/<id>?...`
  - `#/watch/<series>/<id>/<season>/<episode>?...`
- Reproductor fullscreen en modal.
- Para series:
  - temporadas y capítulos,
  - marcado de vistos,
  - reanudar siguiente capítulo,
  - navegación en player: `Volver a la serie`, `Capítulo anterior`, `Siguiente capítulo`,
  - autoplay al siguiente episodio en evento `completed`.

## Persistencia local (`localStorage`)

Claves principales:

- `mep_static_catalog`: cache de títulos descubiertos.
- `mep_series_eps_<imdbId>`: cache de temporadas/capítulos por serie (con TTL).
- `mep_series_progress_<id>`: progreso por serie (vistos, último capítulo).
- `mep_last_watch`: snapshot de reproducción reciente.
- `mep_last_selection`: última selección en UI.

TTL actual de episodios por serie: 14 días.

## Limitaciones (por ser estático)

- Sin backend no hay verificación server-side robusta de disponibilidad por URL.
- Dependencia de endpoints públicos para búsqueda, metadata y build de episodios: puede haber CORS/rate-limit intermitente.
- Calidad de metadata depende de lo que entreguen las fuentes.

## Flujo de trabajo recomendado

### 1) Desarrollar

Trabaja en `main`:

```bash
git checkout main
```

### 2) Publicar cambios

Se publica desde `gh-pages`.

Pasos mínimos:

```bash
git checkout main
# commit/push cambios
git checkout gh-pages
git checkout main -- index.html app.js styles.css
git add index.html app.js styles.css
git commit -m "Sync gh-pages"
git push
git checkout main
```

### 3) Forzar build de Pages (si es necesario)

```bash
gh api -X POST repos/lerna-admin/media-evaluation-platform-static/pages/builds
```

Ver último estado:

```bash
gh api repos/lerna-admin/media-evaluation-platform-static/pages/builds/latest
```

## Continuidad desde otro computador

1. Instalar `git` y `gh` (opcional pero recomendado).
2. Clonar repo:
   - `git clone https://github.com/lerna-admin/media-evaluation-platform-static.git`
3. Entrar al repo y verificar ramas:
   - `git branch -a`
4. Trabajar en `main`.
5. Sincronizar a `gh-pages` para publicar.

## Diagnóstico rápido

Si “Play” no arranca en mobile:

1. Confirmar que la URL cambió a `#/watch/...`.
2. Revisar que el ID sea válido (`tt...` o tmdb numérico).
3. Probar hard refresh.
4. Si persiste, revisar consola del navegador móvil remoto (o replicar en desktop responsive).

Si Pages queda “pegado”:

1. Ver `pages/builds/latest`.
2. Forzar build.
3. Confirmar que fuente siga en `gh-pages` (`legacy`).
