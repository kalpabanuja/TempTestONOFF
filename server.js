require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { exec, spawn } = require('child_process');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_production';
const VALHEIM_CONTAINER = process.env.VALHEIM_CONTAINER || 'valheim';

// Pre-hash the admin password at startup
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_PLAIN = process.env.ADMIN_PASSWORD || 'valheim123';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Live server state (updated by log watcher) ─────────────────────────────────
const liveState = {
  playerCount: 0,
  joinCode: null,
  lastEvent: null,   // e.g. 'player_join', 'player_leave', 'server_start'
};

// Connected /api/events SSE clients
const eventClients = new Set();

function broadcastInfo(extra = {}) {
  const payload = JSON.stringify({ ...liveState, ...extra });
  for (const res of eventClients) {
    res.write(`event: info\ndata: ${payload}\n\n`);
  }
}

// ─── Log Watcher: tails docker logs and reacts to key events ─────────────────────
let watcherProcess = null;

function startLogWatcher() {
  // Kill any previous watcher
  if (watcherProcess) { try { watcherProcess.kill(); } catch (_) {} }

  console.log(`[watcher] Starting log watcher for container: ${VALHEIM_CONTAINER}`);

  watcherProcess = spawn('docker', [
    'logs', '--follow', '--tail', '100', '--timestamps', VALHEIM_CONTAINER
  ]);

  const processLine = (line) => {
    if (!line.trim()) return;

    // ── Server start / restart detected ────────────────────────────────────
    if (/DungeonDB Start|Game server connected|Valheim version/i.test(line)) {
      liveState.playerCount = 0;
      liveState.lastEvent = 'server_start';
      console.log('[watcher] Server start detected — player count reset');
      broadcastInfo();
    }

    // ── Join code detected ────────────────────────────────────────────────
    const joinMatch = line.match(/join\s*code[:\s]+([A-Z0-9]{6,8})/i);
    if (joinMatch) {
      liveState.joinCode = joinMatch[1].toUpperCase();
      console.log(`[watcher] Join code detected: ${liveState.joinCode}`);
      broadcastInfo();
    }

    // ── Player joined ───────────────────────────────────────────────────────
    if (/Got character ZDOID/i.test(line)) {
      liveState.playerCount++;
      liveState.lastEvent = 'player_join';
      console.log(`[watcher] Player joined — count: ${liveState.playerCount}`);
      broadcastInfo();
    }

    // ── Player left ─────────────────────────────────────────────────────────
    if (/Closing socket/i.test(line)) {
      liveState.playerCount = Math.max(0, liveState.playerCount - 1);
      liveState.lastEvent = 'player_leave';
      console.log(`[watcher] Player left — count: ${liveState.playerCount}`);
      broadcastInfo();
    }
  };

  watcherProcess.stdout.on('data', (data) => data.toString().split('\n').forEach(processLine));
  watcherProcess.stderr.on('data', (data) => data.toString().split('\n').forEach(processLine));

  watcherProcess.on('close', (code) => {
    console.log(`[watcher] Log watcher closed (code ${code}). Retrying in 10s...`);
    // Auto-restart watcher — container may be stopped, retry when it comes back up
    setTimeout(startLogWatcher, 10000);
  });

  watcherProcess.on('error', (err) => {
    console.error('[watcher] Spawn error:', err.message);
    setTimeout(startLogWatcher, 10000);
  });
}

// ─── Middleware: Auth ─────────────────────────────────────────────────────────
// SSE (EventSource) cannot send custom headers, so we also accept ?token= query param
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader && authHeader.split(' ')[1];
  const token = headerToken || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// ─── Helper: Run docker command ───────────────────────────────────────────────
function dockerCmd(args) {
  return new Promise((resolve, reject) => {
    exec(`docker ${args}`, (error, stdout, stderr) => {
      if (error) return reject(stderr || error.message);
      resolve(stdout.trim());
    });
  });
}

// ─── POST /api/login ──────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const usernameMatch = username === ADMIN_USERNAME;
  const passwordMatch = password === ADMIN_PASSWORD_PLAIN;

  if (!usernameMatch || !passwordMatch) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, username });
});

// ─── GET /api/status ─────────────────────────────────────────────────────────
app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const result = await dockerCmd(
      `inspect --format="{{.State.Status}}" ${VALHEIM_CONTAINER}`
    );
    res.json({ status: result });
  } catch (err) {
    // If container not found, treat as stopped
    res.json({ status: 'stopped' });
  }
});

// ─── POST /api/server/start ───────────────────────────────────────────────────
app.post('/api/server/start', requireAuth, async (req, res) => {
  try {
    await dockerCmd(`start ${VALHEIM_CONTAINER}`);
    res.json({ success: true, message: 'Server starting...' });
  } catch (err) {
    res.status(500).json({ error: err });
  }
});

// ─── POST /api/server/stop ────────────────────────────────────────────────────
app.post('/api/server/stop', requireAuth, async (req, res) => {
  try {
    await dockerCmd(`stop ${VALHEIM_CONTAINER}`);
    res.json({ success: true, message: 'Server stopped.' });
  } catch (err) {
    res.status(500).json({ error: err });
  }
});

// ─── POST /api/server/restart ─────────────────────────────────────────────────
app.post('/api/server/restart', requireAuth, async (req, res) => {
  try {
    await dockerCmd(`restart ${VALHEIM_CONTAINER}`);
    res.json({ success: true, message: 'Server restarting...' });
  } catch (err) {
    res.status(500).json({ error: err });
  }
});

// ─── GET /api/info (player count + join code) ───────────────────────────────
// Parses recent docker logs from the lloesche/valheim-server image.
// Join code:  logged as "Session \"<name>\" with join code XXXXXX"
// Players:    tracked via "Got character ZDOID" (join) vs "Closing socket" (leave)
app.get('/api/info', requireAuth, async (req, res) => {
  try {
    // Pull last 3000 lines of logs – enough to capture recent session data
    const logs = await new Promise((resolve) => {
      exec(
        `docker logs --tail 3000 ${VALHEIM_CONTAINER} 2>&1`,
        { maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => resolve(stdout || '')
      );
    });

    const lines = logs.split('\n');

    // ── Join code ────────────────────────────────────────────────────────────
    // lloesche image logs: "Session \"My Server\" registered with join code 123456"
    // or:                  "join code: 123456"
    let joinCode = null;
    const joinCodeRegex = /join\s*code[:\s]+([A-Z0-9]{6,8})/i;
    // Scan in reverse to get the most recent one
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(joinCodeRegex);
      if (m) { joinCode = m[1].toUpperCase(); break; }
    }

    // ── Player count ──────────────────────────────────────────────────────────
    // Find the last server startup marker, then count joins/leaves after it.
    // Startup markers in lloesche image:
    //   "Game server connected"  OR  "DungeonDB Start"
    let startIdx = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/DungeonDB Start|Game server connected|Valheim version/i.test(lines[i])) {
        startIdx = i;
        break;
      }
    }

    const sessionLines = lines.slice(startIdx);
    let players = 0;
    for (const line of sessionLines) {
      if (/Got character ZDOID/i.test(line)) players++;
      if (/Closing socket/i.test(line)) players = Math.max(0, players - 1);
    }

    res.json({ joinCode, playerCount: players });
  } catch (err) {
    res.json({ joinCode: null, playerCount: 0 });
  }
});

// ─── GET /api/events (SSE — instant info push) ───────────────────────────────────────
app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state immediately so the page loads with fresh data
  res.write(`event: info\ndata: ${JSON.stringify(liveState)}\n\n`);

  // Send a heartbeat every 25s to keep connection alive through proxies
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);

  eventClients.add(res);

  req.on('close', () => {
    clearInterval(heartbeat);
    eventClients.delete(res);
  });
});

// ─── GET /api/logs (SSE streaming) ────────────────────────────────────────────
app.get('/api/logs', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Tail the last 200 lines then follow
  const logProcess = spawn('docker', [
    'logs',
    '--tail', '200',
    '--follow',
    '--timestamps',
    VALHEIM_CONTAINER,
  ]);

  const sendLine = (data) => {
    const lines = data.toString().split('\n');
    lines.forEach((line) => {
      if (line.trim()) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }
    });
  };

  logProcess.stdout.on('data', sendLine);
  logProcess.stderr.on('data', sendLine); // docker logs outputs to stderr

  logProcess.on('close', () => {
    res.write(`data: ${JSON.stringify('[Log stream ended]')}\n\n`);
    res.end();
  });

  req.on('close', () => {
    logProcess.kill();
  });
});

// ─── Fallback → serve index.html ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Bind on all interfaces so it's reachable via the server's public IP
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚔️  Valheim Admin Panel`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://<server-ip>:${PORT}`);
  console.log(`   Container: ${VALHEIM_CONTAINER}`);
  console.log(`   Login: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD_PLAIN}\n`);

  // Start watching docker logs immediately
  startLogWatcher();
});

