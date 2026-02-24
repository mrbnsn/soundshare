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

function getRoomParticipants(room) {
  const roomSockets = [...io.sockets.adapter.rooms.get(room) || []];
  return roomSockets.map((id) => io.sockets.sockets.get(id)?.username || id);
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
    socket.emit('joined', { username: name, room });
  });

  socket.on('play', (payload) => {
    if (!socket.room) return;
    const atTimestamp = Date.now();
    io.to(socket.room).emit('play', {
      ...payload,
      atTimestamp,
      username: socket.username,
    });
  });

  socket.on('pause', () => {
    if (!socket.room) return;
    io.to(socket.room).emit('pause', { username: socket.username });
  });

  socket.on('seek', (payload) => {
    if (!socket.room) return;
    io.to(socket.room).emit('seek', { ...payload, username: socket.username });
  });

  socket.on('disconnect', () => {
    const { room } = socket;
    participants.delete(socket.id);
    if (room) {
      const names = getRoomParticipants(room);
      io.to(room).emit('participants', { participants: names });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
