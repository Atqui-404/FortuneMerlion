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
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN; // no fallback — fail closed if unset
const CORS_LIST     = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
const CORS_OPT      = CORS_LIST.includes('*') ? '*' : CORS_LIST;
const DB_PATH       = process.env.DB_PATH || path.join(__dirname, 'fortune_merlion.db');
 
// ─── App + Socket.io ───────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: CORS_OPT, methods: ['GET', 'POST'] },
});
 
app.use(cors({ origin: CORS_OPT }));
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

  -- Unconditional log of every valid submission, for event analytics.
  -- Unlike 'scores' (one row per phone, best score only), this keeps every
  -- play so total-plays / plays-per-day / etc. can be reported after the event.
  CREATE TABLE IF NOT EXISTS plays (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    phone      TEXT    NOT NULL,
    score      INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
 
// ─── Validation helpers ────────────────────────────────────────────────────
const PHONE_RE    = /^[89]\d{7}$/;
const VALID_CHARMS = new Set(['empathy','nobility','longevity','vitality','stability','serenity']);
 
function stripHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c])
  );
}

function titleCase(s) {
  return String(s).replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// ─── Name moderation ────────────────────────────────────────────────────────
// Curated from "Leaderboard Display Name Moderation Starter List v1.0" —
// BLOCK-tier terms (general profanity, explicit sexual content, sexual abuse
// terms, hate slurs, threats/self-harm phrases, extremist slogans) plus
// RESERVE-tier (staff/admin impersonation) and spam/solicitation terms.
// REVIEW-tier terms (single violence words, drug references, identity terms,
// mild insults) are deliberately NOT blocked here — the source doc itself
// says these need contextual review, not automatic rejection, and blocking
// them outright would reject legitimate names (the doc explicitly calls out
// "Black", "gay", "Muslim", "trans" etc. as neutral identity words that must
// not be auto-blocked).
const BLOCK_WORDS = [
  // 3.1 general profanity and vulgar insults
  'arse','arsehole','ass','assbag','assface','asshat','asshole','asswipe',
  'bastard','bellend','bitch','bitchass','bitchface','bollocks','bullshit',
  'cocksucker','cunt','dick','dickbag','dickface','dickhead','douche',
  'douchebag','fuck','fucker','fuckface','fuckhead','fucking','fuckwit',
  'goddamn','horseshit','jackass','knob','knobhead','motherfucker',
  'motherfucking','numbnuts','pisshead','prick','scumbag','shit','shitbag',
  'shitface','shithead','shitty','tosser','twat','wanker','whore',
  // 3.2 explicit sexual / pornographic terms
  'anal','analingus','anus','bdsm','blowjob','boner','boob','boobs',
  'bukkake','camgirl','cock','cocks','cum','cumshot','cunnilingus',
  'cybersex','deepthroat','dildo','doggystyle','ejaculate','ejaculation',
  'erotic','escort','fetish','fingering','gangbang','handjob','hardcore',
  'hentai','hooker','horny','intercourse','jerkoff','jizz','masturbate',
  'masturbation','milf','nudes','nudity','onlyfans','orgasm','orgy','penis',
  'porn','porno','pornography','pussy','rimjob','semen','sexcam','sexting',
  'sperm','stripper','testicle','testicles','tits','titties','titty',
  'vagina','vibrator','voyeur','xxx',
  // 3.3 sexual exploitation / severe abuse
  'bestiality','groomer','incest','loli','lolicon','molest','molester',
  'necrophilia','nonconsensual','paedo','paedophile','pedo','pedophile',
  'rape','rapist','zoophile','zoophilia',
  // 3.4 hate slurs and discriminatory abuse
  'beaner','bulldyke','chinaman','chink','coon','coonass','cracker',
  'cripple','dago','darkie','dyke','fag','faggot','faggots','faggy','gook',
  'gypo','gyppo','hebe','homo','honky','hymie','injun','jap','jewboy',
  'kaffir','kike','kraut','lesbo','mick','mongoloid','mudshark','muzzie',
  'nigga','niggas','nigger','niggers','paki','pikey','polack','poof',
  'poofter','raghead','redskin','retard','retarded','shemale','sodomite',
  'spastic','spaz','spic','squaw','towelhead','tranny','wetback','whitey',
  'wog','wop','zipperhead',
  // 3.5 explicit threats / self-harm (single tokens; phrase forms handled separately)
  'dox','doxx','doxxing','kys',
  // 3.6 extremist slogans / orgs
  '1488','kkk','nazi',
  // 5.1 reserved staff/system names — impersonation risk
  'admin','administrator','moderator','gamemaster','helpdesk','official',
  'support','staff','system','verified','verification',
  // 5.2 spam / solicitation
  'onlyfans','paypal','venmo','cashapp','telegram','whatsapp','discord',
  // 4.4 mild insults / crude language — doc recommends BLOCK (not just
  // REVIEW) "for younger audiences or family-safe leaderboards", which this is
  'bimbo','bloody','bozo','brat','bugger','clown','crap','creep','cuck',
  'cuckold','damn','dumb','dummy','freak','freaking','frick','git','hell',
  'hoe','idiot','jerk','lame','loser','moron','noob','piss','pissed','poop',
  'psycho','scum','skank','stupid','suck','thot','tramp','trash','ugly',
];

// Multi-word phrases — checked as substrings post-normalization since they're
// specific enough not to false-positive the way single short tokens can.
const BLOCK_PHRASES = [
  'fuck off','son of a bitch','suck my dick','burn in hell','cut myself',
  'go die','go kill yourself','hang yourself','i will kill you',
  "i'll kill you",'kill yourself','mass shooter','school shooter',
  'self harm','self-harm','unalive yourself','wanna die','want to die',
  'heil hitler','white power','white supremacist','white supremacy',
  'buy account','sell account','free coins','free gems','free skins',
  'gift card','cheap coins','discount code','promo code','link in bio',
];

// Explicit allowlist — legitimate words/names that contain a blocked
// substring but must never be rejected (from the source doc's own
// false-positive warning list). Checked BEFORE the blocklist; if the
// normalized name exactly matches one of these, it's allowed outright.
const ALLOWLIST = [
  'accumulate','analysis','analytics','arsenal','assistance','assistant',
  'bass','canal','class','classic','cockburn','cockpit','cocktail',
  'compass','cucumber','cumulative','dick','dickens','dickinson','document',
  'embassy','essex','fagin','gaylord','grape','grapefruit','grass','hello',
  'massive','middlesex','niger','nigeria','pakistan','pakistani','passage',
  'passion','peacock','penistone','rapeseed','scrape','scunthorpe','shell',
  'shelley','shiitake','skill','skilled','sussex','therapist','title',
  'titus',
  // Common Singapore/Malay/Muslim names colliding with the "ass" root —
  // not in the source doc's own list (which is English-context general
  // purpose), added because this event is in Singapore and these are real,
  // likely-to-occur names, not hypothetical. Treat this section as a living
  // list — extend it if a real attendee's name gets wrongly rejected during
  // the event (the doc's own guidance: provide a rename/appeal path and
  // review the list using real rejection data, not just set-and-forget).
  'hassan','hassim','kassim','bassam','bassim','wassim','yassin','nassir',
  'cassandra',
];

function normalizeForModeration(s) {
  let n = String(s).toLowerCase().normalize('NFKC');
  n = n.replace(/[\u200B-\u200D\uFEFF]/g, ''); // zero-width chars
  const subs = { '4':'a','3':'e','1':'i','!':'i','0':'o','5':'s','$':'s','7':'t','+':'t' };
  n = n.replace(/[43105!$+]/g, c => subs[c] || c); // common leetspeak substitutions
  return n;
}

function collapseRepeats(s) {
  // shiiit -> shit, fuuuck -> fuck: collapse any run of 3+ identical
  // letters down to 1, per the doc's "repeats" normalization guidance
  return s.replace(/([a-z])\1{2,}/g, '$1');
}

function containsProfanity(s) {
  const normalized = normalizeForModeration(s);
  const trimmed = normalized.trim();

  // Exact allowlist match on the whole name — e.g. name is literally "Hello"
  if (ALLOWLIST.includes(trimmed)) return false;

  // Pass 1: whole-word matching (word-boundary aware, so "assistant" or
  // "classic" never match "ass")
  const words = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(w => BLOCK_WORDS.includes(w))) return true;

  // Pass 2: phrase matching — substring is fine here, multi-word phrases
  // are specific enough not to false-positive
  if (BLOCK_PHRASES.some(p => normalized.includes(p))) return true;

  // Pass 3: compact form (separators removed) catches spaced-out evasion
  // like "f.u.c.k" or "f_u_c_k", which pass 1's tokenizer would otherwise
  // split into harmless single letters
  const compact = normalized.replace(/[^a-z0-9]/g, '');
  if (BLOCK_WORDS.some(w => compact.includes(w))) {
    // still respect the allowlist for compact-form matches, checking each
    // allowlist word's own compact form
    const compactAllowlist = ALLOWLIST.map(a => a.replace(/[^a-z0-9]/g, ''));
    if (!compactAllowlist.some(a => compact === a)) return true;
  }

  // Pass 4: repeat-collapsed form catches "shiiit" / "fuuuck" style evasion
  const collapsed = collapseRepeats(compact);
  if (collapsed !== compact && BLOCK_WORDS.some(w => collapsed.includes(w))) {
    return true;
  }

  // Pass 5: substring matching on the compact form, catching compound
  // insults not individually pre-listed (e.g. "Assbob") — allowlist above
  // already covers the known legitimate words that would otherwise trip
  // this on short roots like "ass"/"sex"/"hell"
  if (BLOCK_WORDS.some(w => w.length >= 3 && compact.includes(w))) {
    const compactAllowlist = ALLOWLIST.map(a => a.replace(/[^a-z0-9]/g, ''));
    if (compactAllowlist.some(a => compact === a)) return false;
    return true;
  }

  return false;
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
 
  if (containsProfanity(name))
    return res.status(400).json({ error: 'That name isn\'t allowed — please choose a different one.' });

  const cleanName = titleCase(stripHtml(name.trim()));

  // Log every valid attempt unconditionally (analytics — never deduped, never shown publicly)
  db.prepare('INSERT INTO plays (name, phone, score) VALUES (?, ?, ?)').run(cleanName, phone, score);

  // Leaderboard entry: one row per phone, keeps only the best score (unchanged behavior)
  db.prepare(`
    INSERT INTO scores (name, phone, score) VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      name  = excluded.name,
      score = excluded.score
    WHERE excluded.score > scores.score
  `).run(cleanName, phone, score);
 
  // Rank + score reflect THIS attempt, not necessarily the player's stored
  // best — "where would this specific play currently place on the board",
  // even if it didn't beat their personal best and so wasn't saved as their
  // new leaderboard entry. The leaderboard table itself (one row per phone,
  // best score only) is unaffected by this — only what we tell the CLIENT
  // about THIS submission changes.
  const rank = db.prepare('SELECT COUNT(*) AS cnt FROM scores WHERE score > ?').get(score).cnt + 1;
  const storedScore = db.prepare('SELECT score FROM scores WHERE phone = ?').get(phone).score;
  const isNewBest = score >= storedScore; // true if this attempt IS what's now stored (new best or tied)
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM scores').get().cnt;
  io.emit('player-count', count);

  res.json({ ok: true, rank, score, isNewBest, name: cleanName });
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
 
  if (containsProfanity(name))
    return res.status(400).json({ error: 'That name isn\'t allowed — please choose a different one.' });

  const firstName = titleCase(stripHtml(name.trim().split(/\s+/)[0]));
  io.emit('new-charm', { name: firstName, charm });
 
  res.json({ ok: true });
});
 
// ─── GET /admin/export  (full table incl. phones — Bearer-protected) ───────
app.get('/admin/export', (req, res) => {
  const auth = req.headers.authorization;
  if (!ADMIN_TOKEN || !auth || auth !== `Bearer ${ADMIN_TOKEN}`)
    return res.status(401).json({ error: 'Unauthorized' });
  const scores = db.prepare('SELECT * FROM scores ORDER BY score DESC').all();
  const plays  = db.prepare('SELECT * FROM plays ORDER BY created_at DESC').all();
  const totalPlays    = plays.length;
  const uniquePlayers = scores.length;
  res.json({ totalPlays, uniquePlayers, scores, plays });
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
  if (!ADMIN_TOKEN)
    console.warn('⚠  ADMIN_TOKEN is not set — /admin/export will refuse all requests until it is.');
});