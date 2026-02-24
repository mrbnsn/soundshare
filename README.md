# SoundShare

Synchronized group audio for D&D – play SoundCloud or audio file URLs in a shared lobby so everyone hears the same thing at once.

## Setup

```bash
npm run install:all
```

Or install server and client separately:

```bash
cd server && npm install
cd ../client && npm install
```

## Development

From project root:

```bash
npm run dev
```

This starts the Node server on port 3000 and the Vite dev server on port 5173. Open http://localhost:5173. The client proxies `/socket.io` to the server.

## Production build

```bash
npm run build
npm start
```

Serves the built client from `client/dist` and Socket.io on the same port. Set `NODE_ENV=production` and `PORT` as needed.

## Deploy (Render)

1. Create a new **Web Service** and connect your repo.
2. **Build command:** `npm run install:all && npm run build`
3. **Start command:** `npm start`
4. **Environment:** Add `NODE_ENV` = `production` (optional; Render sets `PORT` automatically).
5. Deploy. The app serves the client and Socket.io on the same URL so WebSockets work without extra config.

Alternatively, use the [render.yaml](render.yaml) blueprint for one-click deploy (if your Render account supports it).
