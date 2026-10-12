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

// ─── Helper: Run docker command ───────────────────────────────────────────────
function dockerCmd(args) {
  return new Promise((resolve, reject) => {
    exec(`docker ${args}`, (error, stdout, stderr) => {
      if (error) return reject(stderr || error.message);
      resolve(stdout.trim());
    });
  });
}

// ─── Live server state (updated by log watcher & status queries) ───────────────
const liveState = {
  playerCount: 0,
  players: [],
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

// ─── Authoritative Server & Player Info Query ─────────────────────────────────
async function getAccurateServerInfo() {
  let joinCode = liveState.joinCode;
  let playerCount = null;
  let playersList = [];

  // 1. Try valheim-status inside the container (authoritative Steam A2S query)
  try {
    const raw = await dockerCmd(`exec ${VALHEIM_CONTAINER} valheim-status`);
    const status = JSON.parse(raw);
    if (status && typeof status.player_count === 'number' && !status.error) {
      playerCount = status.player_count;
      if (Array.isArray(status.players)) {
        playersList = status.players.map((p) => p.name).filter(Boolean);
      }
    }
  } catch (_) {
    // valheim-status not available or query port timed out — fall back to log parsing
  }

  // 2. Read recent logs for Join Code (and player count fallback if query port did not answer)
  try {
    const logs = await new Promise((resolve) => {
      exec(
        `docker logs --tail 2000 ${VALHEIM_CONTAINER} 2>&1`,
        { maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => resolve(stdout || '')
      );
    });

    const lines = logs.split('\n');

    // Extract Join Code (scan backwards for latest)
    const joinCodeRegex = /join\s*code[:\s]+([A-Z0-9]{6,8})/i;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(joinCodeRegex);
      if (m) {
        joinCode = m[1].toUpperCase();
        break;
      }
    }

    // Fallback: Accurate log parser with death filtering and name deduplication
    if (playerCount === null) {
      let startIdx = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/DungeonDB Start|Game server connected|Valheim version/i.test(lines[i])) {
          startIdx = i;
          break;
        }
      }

      const sessionLines = lines.slice(startIdx);
      const onlinePlayers = new Set();

      for (const line of sessionLines) {
        // Player join/spawn: ignore death (0:0)
        const joinMatch = line.match(/Got character ZDOID from\s+(.+?)\s*:\s*(?!0:0)([-0-9]+:[-0-9]+)/i);
        if (joinMatch) {
          const name = joinMatch[1].trim();
          if (name) onlinePlayers.add(name);
        }

        // Disconnect: remove from set
        if (/Closing socket|Disposing socket|Destroying abandoned non persistent zdo/i.test(line)) {
          if (onlinePlayers.size > 0) {
            const first = onlinePlayers.values().next().value;
            onlinePlayers.delete(first);
          }
        }
      }

      playerCount = onlinePlayers.size;
      playersList = Array.from(onlinePlayers);
    }
  } catch (_) {}

  return {
    joinCode: joinCode || liveState.joinCode,
    playerCount: playerCount !== null ? playerCount : liveState.playerCount,
    players: playersList
  };
}

// ─── Log Watcher: tails docker logs and reacts to key events ─────────────────────
let watcherProcess = null;

function startLogWatcher() {
  if (watcherProcess) { try { watcherProcess.kill(); } catch (_) {} }

  console.log(`[watcher] Starting log watcher for container: ${VALHEIM_CONTAINER}`);

  // Initial sync on watcher start
  getAccurateServerInfo().then((info) => {
    liveState.playerCount = info.playerCount;
    if (info.joinCode) liveState.joinCode = info.joinCode;
    liveState.players = info.players;
    broadcastInfo();
  }).catch(() => {});

  // Follow NEW logs from now on (--tail 0 to prevent replaying past lines)
  watcherProcess = spawn('docker', [
    'logs', '--follow', '--tail', '0', '--timestamps', VALHEIM_CONTAINER
  ]);

  // Debounced sync function to fetch authoritative status when a log event happens
  let syncTimer = null;
  const triggerSync = (event) => {
    liveState.lastEvent = event;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      try {
        const info = await getAccurateServerInfo();
        liveState.playerCount = info.playerCount;
        if (info.joinCode) liveState.joinCode = info.joinCode;
        liveState.players = info.players;
        broadcastInfo();
      } catch (_) {}
    }, 600);
  };

  const processLine = (line) => {
    if (!line.trim()) return;

    // Server start / restart detected
    if (/DungeonDB Start|Game server connected|Valheim version/i.test(line)) {
      liveState.playerCount = 0;
      liveState.players = [];
      liveState.lastEvent = 'server_start';
      console.log('[watcher] Server start detected — player count reset');
      broadcastInfo();
      triggerSync('server_start');
      return;
    }

    // Join code detected
    const joinMatch = line.match(/join\s*code[:\s]+([A-Z0-9]{6,8})/i);
    if (joinMatch) {
      liveState.joinCode = joinMatch[1].toUpperCase();
      console.log(`[watcher] Join code detected: ${liveState.joinCode}`);
      broadcastInfo();
      return;
    }

    // Player joined (ignore death 0:0)
    const playerJoin = line.match(/Got character ZDOID from\s+(.+?)\s*:\s*(?!0:0)([-0-9]+:[-0-9]+)/i);
    if (playerJoin) {
      console.log(`[watcher] Player join/spawn: ${playerJoin[1]}`);
      triggerSync('player_join');
      return;
    }

    // Player left
    if (/Closing socket|Disposing socket|Destroying abandoned non persistent zdo/i.test(line)) {
      console.log('[watcher] Player disconnect detected');
      triggerSync('player_leave');
      return;
    }
  };

  watcherProcess.stdout.on('data', (data) => data.toString().split('\n').forEach(processLine));
  watcherProcess.stderr.on('data', (data) => data.toString().split('\n').forEach(processLine));

  watcherProcess.on('close', (code) => {
    console.log(`[watcher] Log watcher closed (code ${code}). Retrying in 10s...`);
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
app.get('/api/info', requireAuth, async (req, res) => {
  try {
    const info = await getAccurateServerInfo();
    liveState.playerCount = info.playerCount;
    if (info.joinCode) liveState.joinCode = info.joinCode;
    liveState.players = info.players;
    res.json(info);
  } catch (err) {
    res.json({
      joinCode: liveState.joinCode,
      playerCount: liveState.playerCount,
      players: liveState.players || []
    });
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

  // Periodic background sync (every 30s) to keep ground truth accurate
  setInterval(async () => {
    try {
      const info = await getAccurateServerInfo();
      const changed =
        info.playerCount !== liveState.playerCount ||
        (info.joinCode && info.joinCode !== liveState.joinCode);
      if (changed) {
        liveState.playerCount = info.playerCount;
        if (info.joinCode) liveState.joinCode = info.joinCode;
        liveState.players = info.players;
        broadcastInfo();
      }
    } catch (_) {}
  }, 30000);
});

