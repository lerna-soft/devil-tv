# Media Evaluation Platform Static

Static frontend-only version designed for GitHub Pages.

## What It Does

- Searches titles live from IMDb suggestions.
- Filters by content type (`all`, `movie`, `series`, `episode`).
- Shows posters and title metadata without persisting catalog data.
- Builds VidAPI embed URLs on the client.
- Supports subtitle parameters (`sub_url`, `sub_label`, `sub_lang`, `ds_lang`, `resumeAt`).
- Supports season/episode selection for series and auto-next episode on `PLAYER_EVENT completed`.

## What It Does Not Do

- No backend API.
- No local database/catalog persistence.
- No profiles or account management.

## Deploy (GitHub Pages)

Use repository root as the Pages source.

- `index.html`
- `styles.css`
- `app.js`
Static frontend-only version of Media Evaluation Platform for GitHub Pages deployment.
