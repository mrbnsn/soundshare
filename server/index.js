import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: isProd ? undefined : { origin: 'http://localhost:5173', methods: ['GET', 'POST'] },
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

io.on('connection', (socket) => {
  socket.on('join', (payload) => {
    const { username, roomId } = payload || {};
    const room = roomId || DEFAULT_ROOM;
    const name = (username || socket.id).trim() || socket.id;
    socket.username = name;
    socket.room = room;
    participants.set(socket.id, { username: name, room });
    socket.join(room);
    const roomSockets = [...io.sockets.adapter.rooms.get(room) || []];
    const names = roomSockets.map((id) => io.sockets.sockets.get(id)?.username || id);
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
      const roomSockets = [...io.sockets.adapter.rooms.get(room) || []];
      const names = roomSockets.map((id) => io.sockets.sockets.get(id)?.username || id);
      io.to(room).emit('participants', { participants: names });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
