# Project Overview

Infinity MD is a Node.js/Express WhatsApp multi-device bot dashboard. The main server is `index.js`, with dashboard pages in `views/`, bot commands in `commands/`, and Firebase/SQLite persistence in `database.js` and `firebase.js`.

## Current Architecture
- Runtime: Node.js CommonJS app started with `node index.js`.
- Web server: raw HTTP server starts first for health checks, then Express routes are registered.
- Persistence: Firebase Realtime Database is primary, SQLite is a local backup/cache.
- WhatsApp connectivity: Baileys powers active bot sessions, QR login, and pairing-code login.
- Deployment files: `railway.json`, `nixpacks.toml`, and `Procfile` configure Railway startup.

## Recent Changes (Latest)
- Added a live edited WhatsApp progress message to `.movie` film downloads. The message now shows separate download and upload progress bars plus speed. Large movie sending uses the saved file path instead of reading the whole file into RAM, downloads use a faster keep-alive streaming pipeline, completed file size is verified, and concurrent movie downloads are limited by `MAX_MOVIE_DOWNLOADS` (default 1). Files up to `MOVIE_UPLOAD_MAX_MB` (default 300MB) send as one document, files up to `MOVIE_SPLIT_MAX_MB` (default 900MB) are split and sent one part at a time, and larger files fall back to direct links to prevent Railway out-of-memory crashes.
- Added `/terabox` Movie Downloader web page: searches sinhalasub.lk, shows movie results, fetches download links from each movie page (TeraBox links sorted to top), and resolves TeraBox share URLs to direct download links via the bot's `resolveTeraBox()` utility.
- Created `utils/sinhalasub.js` shared scraper module — exports `searchMovies()` and `getMovieDetails()`, used by both the `.film3` WhatsApp command and the web API.
- Added three new backend API routes: `POST /api/sinhalasub/search`, `POST /api/sinhalasub/details`, and `POST /api/sinhalasub/resolve`. All include Cloudflare detection with helpful fallback messaging.
- Refactored `commands/media/film3.js` to import from `utils/sinhalasub.js` instead of duplicating the scraper logic.
- Updated `views/landing.html` hero chat bubbles to showcase `.film3tb` and `.film3` movie commands.

## Previous Changes
- Updated `.song` with the provided loader-based YouTube MP3 flow while keeping it compatible with the app's CommonJS command loader, adding URL normalization and multiple fallback download sources.
- Fixed `.yt` video downloads by switching from the older `ytdl-core` package to `@distube/ytdl-core`, normalizing YouTube/Shorts URLs, and adding loader/API fallbacks before reporting failure.
- Migrated the Replit runtime workflow to run the existing Node/Express app on Replit's web preview port (`PORT=5000 node index.js`) without rewriting the project.
- Converted `commands/media/song.js` from ES module syntax to CommonJS so it loads correctly in the existing CommonJS command system; the downloader API key can now be supplied via `SONG_DOWNLOAD_API_KEY`.
- Installed npm dependencies and verified the app starts cleanly in Replit with the landing page rendering in the preview.
- Redesigned dashboard (`views/dashboard.html`) with a fully modern UI: animated gradient mesh background with floating orbs + grid lines, glassmorphism cards, vibrant gradient stat cards with icons, glowing session status rings (green for Online, amber for Paused), improved sidebar with active indicator bar, modern connect tabs, polished QR/pair-code display, and improved toast notifications.
- Added `Restart` button on offline/paused session cards to un-pause sessions directly from the dashboard.
- Fixed welcome message + bot manual re-sending on every reconnect: `firstConnectDone` flag is now persisted to Firebase via `patchSession()` and read from the database on every connect, so the message is sent only once per bot regardless of server restarts.
- Added max reconnect limit (20 attempts): sessions that fail to reconnect after 20 consecutive tries are auto-marked `paused: true` in Firebase. Health monitor and startup both skip paused sessions. Dashboard shows `Paused` status; Restart button clears the flag.
- Added `patchSession()` to database module for patching individual fields without overwriting the full session record.

## Previous Changes
- Hardened `/api/pair` for Railway by retrying temporary Baileys socket creation and pairing-code requests before returning failure.
- Hardened `/api/qr` retry behavior so a QR produced by a retry socket is returned to the browser instead of timing out or reporting service unavailable.
- Added shared temporary socket helpers for safer cleanup, browser signature selection, and clearer WhatsApp readiness errors.
- Added Railway deployment diagnostics at `/api/diagnostics/railway`, with optional deep socket testing via `?deep=1`.
- Updated the dashboard to show backend QR/pair failure details instead of hiding HTTP status or server messages.
- Added lazy WhatsApp core loading so QR/pair retries loading Baileys after startup, and made the `libsignal` dependency explicit for Railway installs.
- Updated Railway Nixpacks setup to include Git/OpenSSH and use an HTTPS lockfile URL for the WhatsApp `libsignal` dependency.
