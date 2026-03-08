const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { 
  cors: { origin: "*" } 
});

const PORT = process.env.PORT || 3001;

// Serve student static files from 'public' folder inside relay directory
// Note: You should copy the contents of your local 'public/student' to a 'relay/public' folder before deploying.
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

console.log(`📡 RecIT Relay Server running on port ${PORT}`);

io.on('connection', (socket) => {
  // Join a room based on PIN
  socket.on('join-room', ({ pin, role }) => {
    socket.join(pin);
    socket.role = role;
    socket.pin = pin;
    console.log(`[${pin}] ${role} (${socket.id}) joined.`);
  });

  // Relay event to others in the same room
  socket.on('relay-event', ({ pin, event, data }) => {
    socket.to(pin).emit(event, data);
  });

  socket.on('disconnect', () => {
    if (socket.pin) {
      console.log(`[${socket.pin}] ${socket.role} (${socket.id}) disconnected.`);
      socket.to(socket.pin).emit('peer-disconnected', { id: socket.id, role: socket.role });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Relay Server listening on http://0.0.0.0:${PORT}`);
});
