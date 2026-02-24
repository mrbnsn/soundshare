# SoundShare

Synchronized group audio for D&D – play SoundCloud or audio file URLs in a shared lobby so everyone hears the same thing at once.

## Requirements

- **Node.js 18 or newer** (LTS recommended, e.g. 20.x). The project enforces this via `engines` in `package.json`; `npm install` will fail if your Node version is too old.

### Installing / switching Node on Windows

**Option A – Direct install (simplest)**  
1. Go to [nodejs.org](https://nodejs.org/) and download the **LTS** installer for Windows.  
2. Run it and follow the steps (this will replace your current Node version).  
3. Open a new terminal and run `node -v` to confirm (e.g. `v20.11.0`).

**Option B – nvm-windows (switch versions per project)**  
1. Install [nvm-windows](https://github.com/coreybutler/nvm-windows/releases) (e.g. `nvm-setup.exe`).  
2. In a new terminal: `nvm install 20` then `nvm use 20`.  
3. This repo includes an `.nvmrc` with `20`, so from the project folder you can run `nvm use` to switch to the right version.

**Option C – fnm (Fast Node Manager)**  
1. Install [fnm](https://github.com/Schniz/fnm#windows) (e.g. via winget: `winget install Schniz.fnm` or the install script).  
2. In a new terminal: `fnm install 20` then `fnm use 20`.  
3. From the project folder, `fnm use` will read `.nvmrc` and switch to Node 20.

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
