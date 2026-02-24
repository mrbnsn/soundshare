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

// ─── HTTP routes ───

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
    if (!resp.ok) { res.status(resp.status).send('Upstream error'); return; }
    let contentType = resp.headers.get('content-type') || 'audio/mpeg';
    if (contentType.includes('text/html')) {
      const html = await resp.text();
      const confirmMatch = html.match(/confirm=([0-9A-Za-z_-]+)/);
      const token = confirmMatch ? confirmMatch[1] : 't';
      resp = await tryUrl(`https://drive.google.com/uc?export=download&confirm=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}`);
      if (!resp.ok) { res.status(resp.status).send('Upstream error'); return; }
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

app.get('/api/youtube-title', async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') { res.json({ title: 'YouTube video' }); return; }
  try {
    const resp = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (resp.ok) {
      const data = await resp.json();
      res.json({ title: data.title || 'YouTube video' });
    } else {
      res.json({ title: 'YouTube video' });
    }
  } catch {
    res.json({ title: 'YouTube video' });
  }
});

if (isProd) {
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// ─── In-memory state ───

const DEFAULT_ROOM = 'lobby';
const MAX_CHAT = 200;
const MAX_HISTORY = 50;

const participants = new Map();
const roomQueue = new Map();
const roomColors = new Map();
const roomChat = new Map();
const roomHistory = new Map();

// WCAG AA 4.5:1+ contrast on #1a1a2e background
const COLOR_PALETTE = [
  '#FF7F7F', '#64B5F6', '#81C784', '#FFD54F',
  '#CE93D8', '#FFB74D', '#4DD0E1', '#AED581',
  '#F48FB1', '#90CAF9', '#FFF176', '#80CBC4',
  '#FFAB91', '#B39DDB', '#C5E1A5', '#EF9A9A',
];

// ─── Helpers ───

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
  const roomSockets = [...(io.sockets.adapter.rooms.get(room) || [])];
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

function getChat(room) {
  const key = room || DEFAULT_ROOM;
  if (!roomChat.has(key)) roomChat.set(key, []);
  return roomChat.get(key);
}

function getHistory(room) {
  const key = room || DEFAULT_ROOM;
  if (!roomHistory.has(key)) roomHistory.set(key, []);
  return roomHistory.get(key);
}

function addToHistory(room, item) {
  if (!item) return;
  const history = getHistory(room);
  history.push({
    type: item.type,
    url: item.url,
    username: item.username,
    name: item.name,
    playedAt: Date.now(),
  });
  if (history.length > MAX_HISTORY) history.shift();
}

function logQueue(label, room) {
  const q = getQueue(room);
  console.log(`[QUEUE ${label}] room="${room || DEFAULT_ROOM}" length=${q.length} items=${JSON.stringify(q.map(i => i.url.slice(-30)))}`);
}

function emitQueue(room) {
  const key = room || DEFAULT_ROOM;
  const snapshot = getQueueSnapshot(room);
  io.to(key).emit('queue', { queue: snapshot });
}

function emitHistory(room) {
  const key = room || DEFAULT_ROOM;
  io.to(key).emit('history', { history: getHistory(room) });
}

function startNextInQueue(room) {
  const key = room || DEFAULT_ROOM;
  const queue = getQueue(room);
  if (queue.length === 0) {
    io.to(key).emit('queue_empty');
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

function clearRoomData(room) {
  roomQueue.delete(room);
  roomChat.delete(room);
  roomHistory.delete(room);
  roomColors.delete(room);
}

// ─── Socket handlers ───

io.on('connection', (socket) => {
  socket.on('join', (payload) => {
    const { username, roomId } = payload || {};
    const room = roomId || DEFAULT_ROOM;
    const name = (username || socket.id).trim() || socket.id;
    socket.username = name;
    socket.room = room;
    participants.set(socket.id, { username: name, room });
    socket.join(room);

    const pList = getRoomParticipants(room);
    io.to(room).emit('participants', { participants: pList });

    const joinEntry = { username: name, message: 'joined the room', timestamp: Date.now(), color: assignColor(room, name), type: 'system' };
    const chat = getChat(room);
    chat.push(joinEntry);
    if (chat.length > MAX_CHAT) chat.shift();
    io.to(room).emit('chat', joinEntry);

    socket.emit('joined', {
      username: name,
      room,
      queue: getQueueSnapshot(room),
      history: getHistory(room),
      chat: getChat(room),
    });
  });

  socket.on('play', (payload) => {
    const room = socket.room || DEFAULT_ROOM;
    const atTimestamp = Date.now();
    const isResume = Number(payload.positionMs) > 0;
    if (isResume) {
      io.to(room).emit('play', { ...payload, atTimestamp, username: socket.username });
      return;
    }
    const queue = getQueue(room);
    const previousLength = queue.length;
    queue.push({ type: payload.type, url: payload.url, username: socket.username, name: payload.name || null });
    logQueue('after push', room);
    emitQueue(room);
    if (previousLength === 0) {
      startNextInQueue(room);
    }
  });

  socket.on('track_ended', () => {
    const room = socket.room || DEFAULT_ROOM;
    const queue = getQueue(room);
    if (queue.length === 0 || queue[0].username !== socket.username) return;
    const finished = queue[0];
    addToHistory(room, finished);
    queue.shift();
    logQueue('after shift', room);
    emitQueue(room);
    emitHistory(room);
    if (queue.length > 0) startNextInQueue(room);
    else io.to(room).emit('queue_empty');
  });

  socket.on('queue_remove', (payload) => {
    const { index } = payload || {};
    const room = socket.room || DEFAULT_ROOM;
    const queue = getQueue(room);
    if (index < 1 || index >= queue.length) return;
    if (queue[index].username !== socket.username) return;
    queue.splice(index, 1);
    logQueue('after remove', room);
    emitQueue(room);
  });

  socket.on('queue_reorder', (payload) => {
    const { fromIndex, toIndex } = payload || {};
    const room = socket.room || DEFAULT_ROOM;
    const queue = getQueue(room);
    if (fromIndex < 1 || toIndex < 1 || fromIndex >= queue.length || toIndex >= queue.length) return;
    if (fromIndex === toIndex) return;
    const [item] = queue.splice(fromIndex, 1);
    queue.splice(toIndex, 0, item);
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

  socket.on('pause', () => {
    const room = socket.room || DEFAULT_ROOM;
    const queue = getQueue(room);
    if (queue.length === 0 || queue[0].username !== socket.username) return;
    io.to(room).emit('pause', { username: socket.username });
  });

  socket.on('seek', (payload) => {
    const room = socket.room || DEFAULT_ROOM;
    io.to(room).emit('seek', { ...payload, username: socket.username });
  });

  socket.on('typing', () => {
    const room = socket.room || DEFAULT_ROOM;
    socket.to(room).emit('typing', { username: socket.username });
  });

  socket.on('chat_message', (payload) => {
    const { message, type: msgType } = payload || {};
    if (!message || typeof message !== 'string') return;
    const room = socket.room || DEFAULT_ROOM;
    const chat = getChat(room);
    const entry = {
      username: socket.username,
      message: message.slice(0, 500),
      timestamp: Date.now(),
      color: assignColor(room, socket.username),
      type: msgType === 'reaction' ? 'reaction' : 'message',
    };
    chat.push(entry);
    if (chat.length > MAX_CHAT) chat.shift();
    io.to(room).emit('chat', entry);
  });

  socket.on('disconnect', () => {
    participants.delete(socket.id);
    const room = socket.room || DEFAULT_ROOM;
    if (!room) return;

    socket.to(room).emit('queue_preview_end');
    const roomSockets = io.sockets.adapter.rooms.get(room);
    const roomEmpty = !roomSockets || roomSockets.size === 0;

    if (roomEmpty) {
      clearRoomData(room);
    } else {
      const leaveEntry = { username: socket.username, message: 'left the room', timestamp: Date.now(), color: assignColor(room, socket.username), type: 'system' };
      const chat = getChat(room);
      chat.push(leaveEntry);
      if (chat.length > MAX_CHAT) chat.shift();
      io.to(room).emit('chat', leaveEntry);
      const queue = getQueue(room);
      if (queue.length > 0 && queue[0].username === socket.username) {
        addToHistory(room, queue[0]);
        queue.shift();
        emitQueue(room);
        emitHistory(room);
        if (queue.length > 0) startNextInQueue(room);
        else io.to(room).emit('queue_empty');
      }
      const pList = getRoomParticipants(room);
      io.to(room).emit('participants', { participants: pList });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
