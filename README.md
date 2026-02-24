# SoundShare

Synchronized group audio for tabletop sessions. Paste a SoundCloud link, Google Drive file, or direct audio URL and everyone in the lobby hears the same thing at the same time. No accounts — just pick a name and join.

## Features

- **Shared queue** — tracks play in order; new additions wait until the current track ends or is skipped.
- **Drag-and-drop reorder** — drag the ☰ handle to rearrange upcoming tracks; changes sync to all clients in real time.
- **SoundCloud, Google Drive & direct URLs** — SoundCloud plays via the Widget API; Google Drive files are streamed through a server proxy; anything else plays as a direct `<audio>` source.
- **Colored usernames** — each participant gets a random accessible color (WCAG AA 4.5:1+ on the dark background) shown everywhere their name appears.
- **Skip** — the person who queued the current track can skip it to advance the queue.
- **Seek & volume** — local volume control and a seek bar (synced for the sharer).

## Requirements

Node.js 18+ (LTS recommended). The `engines` field in `package.json` enforces this.

## Setup

```bash
npm run install:all
```

## Development

```bash
npm run dev
```

Starts the Express/Socket.io server on **:3000** and Vite on **:5173**. Open http://localhost:5173 — the Vite dev server proxies `/socket.io` and `/api` to the backend.

## Production

```bash
npm run build
npm start
```

Serves the built client from `client/dist` and Socket.io on the same port. Set `NODE_ENV=production` and `PORT` as needed.

## Deploy (Render)

Use the included [`render.yaml`](render.yaml) blueprint, or create a Web Service manually:

| Setting | Value |
|---|---|
| Build command | `npm run install:all && npm run build` |
| Start command | `npm start` |
| Environment | `NODE_ENV` = `production` |

Render sets `PORT` automatically. The app serves everything on one origin so WebSockets work without extra config.

## Stack

- **Server** — Node, Express, Socket.io
- **Client** — Vite, vanilla JS
- **Audio** — HTML5 `<audio>`, SoundCloud Widget API, server-side Google Drive proxy
