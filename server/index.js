import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: isProd ? undefined : { origin: 'http://localhost:5173', methods: ['GET', 'POST'] },
});

app.get('/api/audio-proxy', async (req, res) => {
  const id = req.query.id;
  if (!id || typeof id !== 'string') {
    res.status(400).send('Missing id');
    return;
  }
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const tryUrl = (url) => fetch(url, { redirect: 'follow', headers: { 'User-Agent': userAgent } });

  try {
    let resp = await tryUrl(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`);
    if (!resp.ok) {
      res.status(resp.status).send('Upstream error');
      return;
    }
    let contentType = resp.headers.get('content-type') || 'audio/mpeg';
    if (contentType.includes('text/html')) {
      const html = await resp.text();
      const confirmMatch = html.match(/confirm=([0-9A-Za-z_-]+)/);
      const token = confirmMatch ? confirmMatch[1] : 't';
      resp = await tryUrl(`https://drive.google.com/uc?export=download&confirm=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}`);
      if (!resp.ok) {
        res.status(resp.status).send('Upstream error');
        return;
      }
      contentType = resp.headers.get('content-type') || 'audio/mpeg';
      if (contentType.includes('text/html')) {
        res.status(502).send('Google Drive returned a page instead of a file. Ensure the file is shared with "Anyone with the link" and try again.');
        return;
      }
    }
    res.setHeader('Content-Type', contentType);
    Readable.fromWeb(resp.body).pipe(res);
  } catch (err) {
    console.error('Audio proxy error:', err.message);
    res.status(502).send('Could not fetch file');
  }
});

if (isProd) {
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const DEFAULT_ROOM = 'lobby';
const participants = new Map();
const roomQueue = new Map();
const roomColors = new Map();

// WCAG AA 4.5:1+ contrast on #1a1a2e background
const COLOR_PALETTE = [
  '#FF7F7F', '#64B5F6', '#81C784', '#FFD54F',
  '#CE93D8', '#FFB74D', '#4DD0E1', '#AED581',
  '#F48FB1', '#90CAF9', '#FFF176', '#80CBC4',
  '#FFAB91', '#B39DDB', '#C5E1A5', '#EF9A9A',
];

function assignColor(room, username) {
  const key = room || DEFAULT_ROOM;
  if (!roomColors.has(key)) roomColors.set(key, new Map());
  const colors = roomColors.get(key);
  if (colors.has(username)) return colors.get(username);
  const used = new Set(colors.values());
  const available = COLOR_PALETTE.filter(c => !used.has(c));
  const pick = available.length > 0 ? available : COLOR_PALETTE;
  colors.set(username, pick[colors.size % pick.length]);
  return colors.get(username);
}

function getRoomParticipants(room) {
  const roomSockets = [...io.sockets.adapter.rooms.get(room) || []];
  return roomSockets.map((id) => {
    const s = io.sockets.sockets.get(id);
    const uname = s?.username || id;
    return { username: uname, color: assignColor(room, uname) };
  });
}

function getQueue(room) {
  const key = room || DEFAULT_ROOM;
  if (!roomQueue.has(key)) roomQueue.set(key, []);
  return roomQueue.get(key);
}

function getQueueSnapshot(room) {
  return getQueue(room).map(({ type, url, username, name }) => ({ type, url, username, name }));
}

function logQueue(label, room) {
  const q = getQueue(room);
  console.log(`[QUEUE ${label}] room="${room || DEFAULT_ROOM}" length=${q.length} items=${JSON.stringify(q.map(i => i.url.slice(-30)))}`);
}

function emitQueue(room) {
  const key = room || DEFAULT_ROOM;
  const snapshot = getQueueSnapshot(room);
  console.log(`[QUEUE emitQueue] room="${key}" snapshot.length=${snapshot.length}`);
  io.to(key).emit('queue', { queue: snapshot });
}

function startNextInQueue(room) {
  const key = room || DEFAULT_ROOM;
  const queue = getQueue(room);
  if (queue.length === 0) {
    console.log(`[QUEUE startNext] room="${key}" queue empty, nothing to start`);
    return;
  }
  const atTimestamp = Date.now();
  const item = queue[0];
  const queueSnapshot = getQueueSnapshot(room);
  console.log(`[QUEUE startNext] room="${key}" playing: "${item.url.slice(-30)}" by ${item.username}, queueLen=${queue.length}`);
  io.to(key).emit('queue', { queue: queueSnapshot });
  io.to(key).emit('play', {
    type: item.type,
    url: item.url,
    positionMs: 0,
    atTimestamp,
    username: item.username,
    name: item.name,
    queue: queueSnapshot,
  });
}

io.on('connection', (socket) => {
  socket.on('join', (payload) => {
    const { username, roomId } = payload || {};
    const room = roomId || DEFAULT_ROOM;
    const name = (username || socket.id).trim() || socket.id;
    socket.username = name;
    socket.room = room;
    participants.set(socket.id, { username: name, room });
    socket.join(room);
    const names = getRoomParticipants(room);
    io.to(room).emit('participants', { participants: names });
    socket.emit('joined', { username: name, room, queue: getQueueSnapshot(room) });
  });

  socket.on('play', (payload) => {
    const room = socket.room || DEFAULT_ROOM;
    const atTimestamp = Date.now();
    const isResume = Number(payload.positionMs) > 0;
    console.log(`[EVENT play] user=${socket.username} room=${room} url="${(payload.url||'').slice(-30)}" positionMs=${payload.positionMs} isResume=${isResume}`);
    if (isResume) {
      io.to(room).emit('play', { ...payload, atTimestamp, username: socket.username });
      return;
    }
    const queue = getQueue(room);
    const previousLength = queue.length;
    queue.push({ type: payload.type, url: payload.url, username: socket.username, name: payload.name || null });
    console.log(`[EVENT play] previousLength=${previousLength} newLength=${queue.length} → ${previousLength === 0 ? 'STARTING playback' : 'QUEUED (no playback change)'}`);
    logQueue('after push', room);
    emitQueue(room);
    if (previousLength === 0) {
      startNextInQueue(room);
    }
  });

  socket.on('track_ended', () => {
    const room = socket.room || DEFAULT_ROOM;
    const queue = getQueue(room);
    console.log(`[EVENT track_ended] user=${socket.username} room=${room} queueLen=${queue.length} front=${queue[0]?.username || 'EMPTY'}`);
    if (queue.length === 0 || queue[0].username !== socket.username) {
      console.log(`[EVENT track_ended] IGNORED (empty queue or user mismatch)`);
      return;
    }
    queue.shift();
    console.log(`[EVENT track_ended] shifted queue, newLen=${queue.length}`);
    logQueue('after shift', room);
    emitQueue(room);
    if (queue.length > 0) startNextInQueue(room);
  });

  socket.on('queue_reorder', (payload) => {
    const { fromIndex, toIndex } = payload || {};
    const room = socket.room || DEFAULT_ROOM;
    const queue = getQueue(room);
    if (fromIndex < 1 || toIndex < 1 || fromIndex >= queue.length || toIndex >= queue.length) return;
    if (fromIndex === toIndex) return;
    const [item] = queue.splice(fromIndex, 1);
    queue.splice(toIndex, 0, item);
    console.log(`[QUEUE reorder] room="${room}" from=${fromIndex} to=${toIndex}`);
    logQueue('after reorder', room);
    emitQueue(room);
  });

  socket.on('queue_drag', (payload) => {
    const room = socket.room || DEFAULT_ROOM;
    socket.to(room).emit('queue_preview', {
      fromIndex: payload.fromIndex,
      hoverIndex: payload.hoverIndex,
      username: socket.username,
    });
  });

  socket.on('queue_drag_end', () => {
    const room = socket.room || DEFAULT_ROOM;
    socket.to(room).emit('queue_preview_end');
  });

  socket.on('seek', (payload) => {
    const room = socket.room || DEFAULT_ROOM;
    io.to(room).emit('seek', { ...payload, username: socket.username });
  });

  socket.on('disconnect', () => {
    console.log(`[EVENT disconnect] user=${socket.username} room=${socket.room}`);
    participants.delete(socket.id);
    const room = socket.room || DEFAULT_ROOM;
    if (room) {
      socket.to(room).emit('queue_preview_end');
      const roomSockets = io.sockets.adapter.rooms.get(room);
      const roomEmpty = !roomSockets || roomSockets.size === 0;
      if (roomEmpty) {
        console.log(`[EVENT disconnect] room "${room}" is now empty, clearing queue`);
        roomQueue.delete(room);
      } else {
        const queue = getQueue(room);
        if (queue.length > 0 && queue[0].username === socket.username) {
          console.log(`[EVENT disconnect] user was sharer, shifting queue`);
          queue.shift();
          emitQueue(room);
          if (queue.length > 0) startNextInQueue(room);
        }
      }
      const pList = getRoomParticipants(room);
      io.to(room).emit('participants', { participants: pList });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
