'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const DB_FILE = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(DB_FILE);

// Create tables if missing
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT,
    code TEXT UNIQUE,
    avatar TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    friend_id INTEGER,
    UNIQUE(user_id, friend_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    group_code TEXT UNIQUE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER,
    user_id INTEGER,
    UNIQUE(group_id, user_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER,
    user_id INTEGER,
    username TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS dms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a INTEGER,
    user_b INTEGER,
    UNIQUE(user_a, user_b)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS dm_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dm_id INTEGER,
    sender_id INTEGER,
    sender_username TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware (cookie-based persistent)
const sessionMiddleware = session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: __dirname }),
  secret: process.env.SESSION_SECRET || 'change_this_secret_for_dev',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } // 30 days
});
app.use(sessionMiddleware);

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2,8) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } }); // 2MB

function generateCode() {
  return uuidv4().split('-')[0].toUpperCase();
}

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// --- Auth API ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  const password_hash = await bcrypt.hash(password, 10);
  const code = generateCode();
  db.run(`INSERT INTO users (username, password_hash, code) VALUES (?, ?, ?)`, [username, password_hash, code], function(err) {
    if (err) return res.status(400).json({ error: 'Username taken' });
    const user = { id: this.lastID, username, code };
    req.session.user = user;
    res.json({ user });
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, row) => {
    if (err || !row) return res.status(400).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
    const user = { id: row.id, username: row.username, code: row.code, avatar: row.avatar };
    req.session.user = user;
    res.json({ user });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => { if (err) return res.json({ error: 'Logout error' }); res.json({ ok: true }); });
});

app.get('/api/me', requireLogin, (req, res) => {
  const user = req.session.user;
  db.get(`SELECT id, username, code, avatar FROM users WHERE id = ?`, [user.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'User not found' });
    db.all(`SELECT u.id, u.username, u.code, u.avatar FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ?`, [row.id], (err2, friends) => {
      if (err2) friends = [];
      res.json({ user: row, friends });
    });
  });
});

// --- Friend management ---
app.post('/api/add-friend', requireLogin, (req, res) => {
  const user = req.session.user;
  const { friendCode } = req.body;
  if (!friendCode) return res.status(400).json({ error: 'Missing friendCode' });
  db.get(`SELECT id FROM users WHERE code = ?`, [friendCode], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Friend not found' });
    const friendId = row.id;
    if (friendId === user.id) return res.status(400).json({ error: 'Cannot add yourself' });
    db.run(`INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)`, [user.id, friendId], function(err2) {
      if (err2) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true });
    });
  });
});

// --- Avatar upload ---
app.post('/api/upload-avatar', requireLogin, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const avatarPath = '/uploads/' + path.basename(req.file.path);
  db.run(`UPDATE users SET avatar = ? WHERE id = ?`, [avatarPath, req.session.user.id], function(err) {
    if (err) return res.status(500).json({ error: 'DB error' });
    req.session.user.avatar = avatarPath;
    res.json({ avatar: avatarPath });
  });
});

// --- Groups ---
app.post('/api/create-group', requireLogin, (req, res) => {
  const user = req.session.user; const { name } = req.body;
  const groupCode = generateCode();
  db.run(`INSERT INTO groups (name, group_code) VALUES (?, ?)`, [name || 'Group', groupCode], function(err) {
    if (err) return res.status(500).json({ error: 'DB error' });
    const groupId = this.lastID;
    db.run(`INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`, [groupId, user.id]);
    res.json({ group: { id: groupId, name: name || 'Group', group_code: groupCode }});
  });
});

app.post('/api/join-group', requireLogin, (req, res) => {
  const user = req.session.user; const { groupCode } = req.body;
  if (!groupCode) return res.status(400).json({ error: 'Missing groupCode' });
  db.get(`SELECT id FROM groups WHERE group_code = ?`, [groupCode], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Group not found' });
    const groupId = row.id;
    db.get(`SELECT COUNT(*) as cnt FROM group_members WHERE group_id = ?`, [groupId], (err2, cRow) => {
      const cnt = cRow ? cRow.cnt : 0;
      if (cnt >= 10) return res.status(400).json({ error: 'Group is full (10 max)' });
      db.run(`INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)`, [groupId, user.id], function(err3) {
        if (err3) return res.status(500).json({ error: 'DB error' });
        res.json({ success: true });
      });
    });
  });
});

app.get('/api/my-groups', requireLogin, (req, res) => {
  const user = req.session.user;
  db.all(`SELECT g.id, g.name, g.group_code FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ?`, [user.id], (err, rows) => {
    if (err) return res.json({ groups: [] });
    res.json({ groups: rows });
  });
});

app.get('/api/group-messages/:groupId', requireLogin, (req, res) => {
  const groupId = req.params.groupId;
  db.all(`SELECT m.*, u.username as author FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.created_at DESC LIMIT 100`, [groupId], (err, rows) => {
    if (err) return res.json({ messages: [] });
    res.json({ messages: rows.reverse() });
  });
});

// --- DMs ---
app.post('/api/dm', requireLogin, (req, res) => {
  const user = req.session.user; const { friendId } = req.body;
  if (!friendId) return res.status(400).json({ error: 'Missing friendId' });
  db.get(`SELECT id, username, avatar FROM users WHERE id = ?`, [friendId], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'User not found' });
    const a = Math.min(user.id, friendId); const b = Math.max(user.id, friendId);
    db.run(`INSERT OR IGNORE INTO dms (user_a, user_b) VALUES (?, ?)`, [a, b], function(err2) {
      if (err2) return res.status(500).json({ error: 'DB error' });
      db.get(`SELECT id FROM dms WHERE user_a = ? AND user_b = ?`, [a, b], (err3, dmRow) => {
        if (err3 || !dmRow) return res.status(500).json({ error: 'DM error' });
        res.json({ dm: { id: dmRow.id, with: row.username, avatar: row.avatar } });
      });
    });
  });
});

app.get('/api/my-dms', requireLogin, (req, res) => {
  const user = req.session.user;
  db.all(`SELECT d.id, CASE WHEN d.user_a = ? THEN d.user_b ELSE d.user_a END as other_id FROM dms d WHERE d.user_a = ? OR d.user_b = ?`, [user.id, user.id, user.id], (err, rows) => {
    if (err) return res.json({ dms: [] });
    const promises = rows.map(r => new Promise((resolve) => {
      db.get(`SELECT id, username, code, avatar FROM users WHERE id = ?`, [r.other_id], (e,u) => resolve(u || null));
    }));
    Promise.all(promises).then(results => res.json({ dms: results.filter(x=>x) }));
  });
});

app.get('/api/dm-messages/:dmId', requireLogin, (req, res) => {
  const dmId = req.params.dmId;
  db.all(`SELECT * FROM dm_messages WHERE dm_id = ? ORDER BY created_at DESC LIMIT 100`, [dmId], (err, rows) => {
    if (err) return res.json({ messages: [] });
    res.json({ messages: rows.reverse() });
  });
});

// --- Online / presence helper ---
// map userId -> socketId (single connection for simplicity)
const online = {};

app.get('/api/online-friends', requireLogin, (req, res) => {
  const user = req.session.user;
  db.all(`SELECT u.id, u.username, u.code, u.avatar FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ?`, [user.id], (err, friends) => {
    if (err) return res.json({ friends: [] });
    const out = (friends || []).map(f => ({ id: f.id, username: f.username, code: f.code, avatar: f.avatar, socketId: online[f.id] || null }));
    res.json({ friends: out });
  });
});

// --- Socket.io and session reuse ---
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// roomCounts map room -> array of socket ids
const roomCounts = {};

io.on('connection', (socket) => {
  const req = socket.request;
  const sess = req.session;
  if (sess && sess.user) {
    online[sess.user.id] = socket.id;
    // update server console
    console.log('socket connected:', socket.id, 'user:', sess.user.username || sess.user.code);
  } else {
    // not authenticated session; disconnect to be safe
    socket.disconnect(true);
    return;
  }

  const user = sess.user;

  socket.on('join-group', (groupId, ack) => {
    db.get(`SELECT COUNT(*) as cnt FROM group_members WHERE group_id = ?`, [groupId], (err, row) => {
      const cnt = row ? row.cnt : 0;
      const key = 'group_' + groupId;
      const memCnt = Array.isArray(roomCounts[key]) ? roomCounts[key].length : 0;
      if (cnt >= 10 || memCnt >= 10) { if (ack) ack({ error: 'Group is full (10 max)' }); return; }
      socket.join(key);
      if (!Array.isArray(roomCounts[key])) roomCounts[key] = [];
      roomCounts[key].push(socket.id);
      if (ack) ack({ ok: true });
    });
  });

  socket.on('leave-group', (groupId) => {
    const key = 'group_' + groupId;
    socket.leave(key);
    if (Array.isArray(roomCounts[key])) {
      roomCounts[key] = roomCounts[key].filter(id => id !== socket.id);
      if (roomCounts[key].length === 0) delete roomCounts[key];
    }
  });

  socket.on('group-message', (data, ack) => {
    const { groupId, content } = data;
    if (!groupId || !content) { if (ack) ack({ error: 'Invalid' }); return; }
    db.run(`INSERT INTO messages (group_id, user_id, username, content) VALUES (?, ?, ?, ?)`, [groupId, user.id, user.username, content], function(err) {
      if (err) { if (ack) ack({ error: 'DB error' }); return; }
      const msg = { id: this.lastID, groupId, user_id: user.id, username: user.username, content, created_at: new Date().toISOString() };
      io.to('group_' + groupId).emit('group-message', msg);
      if (ack) ack({ ok: true });
    });
  });

  socket.on('join-dm', (dmId, ack) => {
    socket.join('dm_' + dmId);
    if (ack) ack({ ok: true });
  });

  socket.on('dm-message', (data, ack) => {
    const { dmId, content } = data;
    if (!dmId || !content) { if (ack) ack({ error: 'Invalid' }); return; }
    db.run(`INSERT INTO dm_messages (dm_id, sender_id, sender_username, content) VALUES (?, ?, ?, ?)`, [dmId, user.id, user.username, content], function(err) {
      if (err) { if (ack) ack({ error: 'DB error' }); return; }
      const msg = { id: this.lastID, dmId, sender_id: user.id, sender_username: user.username, content, created_at: new Date().toISOString() };
      io.to('dm_' + dmId).emit('dm-message', msg);
      if (ack) ack({ ok: true });
    });
  });

  // WebRTC signaling
  socket.on('call-user', (data) => {
    // data: { toUserId, offer }
    const targetSocket = online[data.toUserId];
    if (targetSocket) {
      io.to(targetSocket).emit('incoming-call', { fromUserId: user.id, fromUsername: user.username, offer: data.offer, fromSocketId: socket.id });
    }
  });

  socket.on('answer-call', (data) => {
    // data: { toSocketId, answer }
    io.to(data.toSocketId).emit('call-accepted', { answer: data.answer, fromSocketId: socket.id });
  });

  socket.on('ice-candidate', (data) => {
    // data: { toSocketId, candidate }
    io.to(data.toSocketId).emit('ice-candidate', { candidate: data.candidate });
  });

  socket.on('disconnect', () => {
    // remove online mapping
    if (user && user.id && online[user.id] === socket.id) delete online[user.id];
    // cleanup roomCounts
    Object.keys(roomCounts).forEach(k => {
      if (Array.isArray(roomCounts[k]) && roomCounts[k].includes(socket.id)) {
        roomCounts[k] = roomCounts[k].filter(id => id !== socket.id);
        if (roomCounts[k].length === 0) delete roomCounts[k];
      }
    });
  });
});

server.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
