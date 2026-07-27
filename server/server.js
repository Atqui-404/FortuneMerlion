'use strict';

const express    = require('express');
const http       = require('http');
const { Server }       = require('socket.io');
const { DatabaseSync } = require('node:sqlite'); // built-in, needs Node ≥22.5
const cors             = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

// ─── Config ────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT         || 3000;
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN  || 'dev-token-CHANGE-IN-PRODUCTION';
const CORS_ORIGIN  = process.env.CORS_ORIGIN  || '*';
const DB_PATH      = process.env.DB_PATH      || path.join(__dirname, 'fortune_merlion.db');

// ─── App + Socket.io ───────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
});

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
// Serve game client at root AND at /game
// Both www.fortunemerlion.com/ and www.fortunemerlion.com/game work
app.use('/game', express.static(path.join(__dirname, '../client')));
app.use(express.static(path.join(__dirname, '../client')));

// ─── Database ──────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    phone      TEXT    NOT NULL,
    score      INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  -- Deduplicate existing rows: keep the highest score per phone before enforcing uniqueness
  DELETE FROM scores WHERE id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY phone ORDER BY score DESC, id DESC) AS rn
      FROM scores
    ) WHERE rn = 1
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_scores_phone ON scores(phone);
`);

// ─── Validation helpers ────────────────────────────────────────────────────
const PHONE_RE    = /^[89]\d{7}$/;
const VALID_CHARMS = new Set(['love','luck','health','calm','win','joy','fame','fortune']);

function stripHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c])
  );
}

// ─── Rate limiters ─────────────────────────────────────────────────────────
const limiter10 = rateLimit({
  windowMs: 60_000, max: 10,
  standardHeaders: true, legacyHeaders: false,
});

// ─── POST /score ───────────────────────────────────────────────────────────
app.post('/score', limiter10, (req, res) => {
  try {
  const { name, phone, score } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 20)
    return res.status(400).json({ error: 'Invalid name (1–20 chars)' });
  if (!phone || !PHONE_RE.test(phone))
    return res.status(400).json({ error: 'Invalid SG mobile — must start with 8 or 9, 8 digits total' });
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 2000)
    return res.status(400).json({ error: 'Invalid score' });

  const cleanName = stripHtml(name.trim());
  db.prepare(`
    INSERT INTO scores (name, phone, score) VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      name  = excluded.name,
      score = excluded.score
    WHERE excluded.score > scores.score
  `).run(cleanName, phone, score);

  // Rank = number of distinct players with a strictly higher score + 1
  const storedScore = db.prepare('SELECT score FROM scores WHERE phone = ?').get(phone).score;
  const rank  = db.prepare('SELECT COUNT(*) AS cnt FROM scores WHERE score > ?').get(storedScore).cnt + 1;
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM scores').get().cnt;
  io.emit('player-count', count);

  res.json({ ok: true, rank, score: storedScore });
  } catch(err) {
    console.error('POST /score error:', err.message);
    res.status(500).json({ error: 'Server error — please try again.' });
  }
});

// ─── GET /leaderboard  (phone NEVER returned) ──────────────────────────────
app.get('/leaderboard', (req, res) => {
  const rows = db.prepare(
    'SELECT name, score FROM scores ORDER BY score DESC, created_at ASC LIMIT 10'
  ).all();
  res.json(rows);
});

// ─── POST /charm ───────────────────────────────────────────────────────────
app.post('/charm', limiter10, (req, res) => {
  const { name, charm } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 20)
    return res.status(400).json({ error: 'Invalid name' });
  if (!charm || !VALID_CHARMS.has(charm))
    return res.status(400).json({ error: 'Invalid charm' });

  const firstName = stripHtml(name.trim().split(/\s+/)[0]);
  io.emit('new-charm', { name: firstName, charm });

  res.json({ ok: true });
});

// ─── GET /admin/export  (full table incl. phones — Bearer-protected) ───────
app.get('/admin/export', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${ADMIN_TOKEN}`)
    return res.status(401).json({ error: 'Unauthorized' });
  const rows = db.prepare('SELECT * FROM scores ORDER BY score DESC').all();
  res.json(rows);
});

// ─── Socket.io ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Display connected:', socket.id);
  // Send current totals to newly connected display
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM scores').get().cnt;
  socket.emit('player-count', count);
  socket.on('disconnect', () => console.log('Display disconnected:', socket.id));
});

// ─── Start ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Fortune Merlion server running on port ${PORT}`);
  if (ADMIN_TOKEN === 'dev-token-CHANGE-IN-PRODUCTION')
    console.warn('⚠  ADMIN_TOKEN is the default dev value — set a secure token in production!');
});
