require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { exec, spawn } = require('child_process');
const path = require('path');
const cors = require('cors');
const activityTracker = require('./activityTracker');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_production';
const VALHEIM_CONTAINER = process.env.VALHEIM_CONTAINER || 'valheim';

// Pre-hash the admin and user credentials at startup
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_PLAIN = process.env.ADMIN_PASSWORD || 'valheim123';
const USER_USERNAME = process.env.USER_USERNAME || 'user';
const USER_PASSWORD_PLAIN = process.env.USER_PASSWORD || 'valheimuser';

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

function broadcastActivity(event) {
  if (!event) return;
  const payload = JSON.stringify(event);
  for (const res of eventClients) {
    res.write(`event: activity\ndata: ${payload}\n\n`);
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

  // Update activity tracker registry with verified online players
  if (Array.isArray(playersList) && playersList.length > 0) {
    playersList.forEach((name) => {
      activityTracker.registerPlayer(name, { online: true });
    });
  }

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

  // Backfill recent logs on watcher startup into activity tracker
  exec(
    `docker logs --tail 2500 ${VALHEIM_CONTAINER} 2>&1`,
    { maxBuffer: 10 * 1024 * 1024 },
    (err, stdout) => {
      if (stdout) activityTracker.backfillLogs(stdout);
    }
  );

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

    // Ingest into user activity tracker for audit & security monitoring
    activityTracker.processLogLine(line);

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

// ─── Middleware: Auth & Roles ─────────────────────────────────────────────
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

// Admin-only middleware (for user activity, player IPs, and server control)
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user && req.user.role === 'admin') {
      next();
    } else {
      res.status(403).json({ error: 'Access denied: Admin privileges required' });
    }
  });
}

// ─── POST /api/login ──────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const isAdmin = username === ADMIN_USERNAME && password === ADMIN_PASSWORD_PLAIN;
  const isUser = username === USER_USERNAME && password === USER_PASSWORD_PLAIN;

  if (!isAdmin && !isUser) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const role = isAdmin ? 'admin' : 'user';
  const token = jwt.sign({ username, role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, username, role });
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
app.post('/api/server/start', requireAdmin, async (req, res) => {
  try {
    await dockerCmd(`start ${VALHEIM_CONTAINER}`);
    res.json({ success: true, message: 'Server starting...' });
  } catch (err) {
    res.status(500).json({ error: err });
  }
});

// ─── POST /api/server/stop ────────────────────────────────────────────────────
app.post('/api/server/stop', requireAdmin, async (req, res) => {
  try {
    await dockerCmd(`stop ${VALHEIM_CONTAINER}`);
    res.json({ success: true, message: 'Server stopped.' });
  } catch (err) {
    res.status(500).json({ error: err });
  }
});

// ─── POST /api/server/restart ─────────────────────────────────────────────────
app.post('/api/server/restart', requireAdmin, async (req, res) => {
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

// ─── Helper: Extract world name & seed from Valheim save metadata ─────────────
async function detectWorldSeed() {
  let worldName = null;
  let seed = null;

  // 1. Detect world name from container env or recent logs
  try {
    const envWorld = await dockerCmd(`exec ${VALHEIM_CONTAINER} sh -c "echo \\$WORLD_NAME || echo \\$SERVER_WORLD"`);
    if (envWorld && envWorld.trim() && !envWorld.includes('$')) {
      worldName = envWorld.trim();
    }
  } catch (_) {}

  // If not found in env, check recent logs
  if (!worldName) {
    try {
      const logs = await new Promise((resolve) => {
        exec(
          `docker logs --tail 2000 ${VALHEIM_CONTAINER} 2>&1`,
          { maxBuffer: 10 * 1024 * 1024 },
          (err, stdout) => resolve(stdout || '')
        );
      });
      const lines = logs.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/ZNet\.LoadWorld:\s*([^\s(]+)/i) ||
                  lines[i].match(/Get create world\s+([^\s\r\n]+)/i) ||
                  lines[i].match(/world:\s*([^\s,]+)/i);
        if (m) {
          worldName = m[1].trim();
          break;
        }
      }
    } catch (_) {}
  }

  if (!worldName) worldName = 'Dedicated';

  // 2. Find latest .fwl2 or .fwl file inside the container
  try {
    const findCmd = `exec ${VALHEIM_CONTAINER} sh -c "ls -t /config/worlds_local/${worldName}/_main.*.fwl2 /config/worlds_local/${worldName}.fwl /config/worlds_local/*/_main.*.fwl2 /config/worlds_local/*.fwl 2>/dev/null | head -n 1"`;
    const fwlPath = (await dockerCmd(findCmd)).trim();

    if (fwlPath) {
      // Read first 256 bytes encoded in base64 to avoid binary stdout issues
      const b64 = (await dockerCmd(`exec ${VALHEIM_CONTAINER} sh -c "head -c 256 '${fwlPath}' | base64"`)).replace(/\s+/g, '');
      const buf = Buffer.from(b64, 'base64');

      // Valheim C# BinaryWriter serializes string as:
      // [7-bit encoded int length] + [UTF-8 bytes]
      // Field 1: World Name, Field 2: World Seed
      let offset = 0;
      function read7BitInt() {
        let count = 0, shift = 0;
        while (shift < 35 && offset < buf.length) {
          const byte = buf[offset++];
          count |= (byte & 0x7f) << shift;
          shift += 7;
          if ((byte & 0x80) === 0) break;
        }
        return count;
      }

      // Read World Name
      const nameLen = read7BitInt();
      if (nameLen > 0 && offset + nameLen <= buf.length) {
        const parsedName = buf.toString('utf8', offset, offset + nameLen);
        offset += nameLen;
        if (parsedName && parsedName.length > 0) {
          worldName = parsedName;
        }

        // Read World Seed
        const seedLen = read7BitInt();
        if (seedLen > 0 && offset + seedLen <= buf.length) {
          const parsedSeed = buf.toString('utf8', offset, offset + seedLen);
          if (parsedSeed && parsedSeed.length > 0 && /^[\w\s.-]+$/.test(parsedSeed)) {
            seed = parsedSeed;
          }
        }
      }
    }
  } catch (_) {}

  return { worldName, seed };
}

// ─── GET /api/world ──────────────────────────────────────────────────────────
app.get('/api/world', requireAuth, async (req, res) => {
  try {
    const data = await detectWorldSeed();
    const finalSeed = data.seed || liveState.customSeed || null;
    res.json({
      worldName: data.worldName || 'Dedicated',
      seed: finalSeed,
      mapUrl: finalSeed
        ? `https://valheim-map.world/?seed=${encodeURIComponent(finalSeed)}`
        : 'https://valheim-map.world/'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/world/seed ────────────────────────────────────────────────────
app.post('/api/world/seed', requireAuth, async (req, res) => {
  const { seed } = req.body;
  if (typeof seed === 'string') {
    liveState.customSeed = seed.trim();
  }
  res.json({
    success: true,
    seed: liveState.customSeed,
    mapUrl: liveState.customSeed
      ? `https://valheim-map.world/?seed=${encodeURIComponent(liveState.customSeed)}`
      : 'https://valheim-map.world/'
  });
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

// ─── GET /api/activity (filtered user audit & activity logs — Admin Only) ───
app.get('/api/activity', requireAdmin, (req, res) => {
  try {
    const events = activityTracker.getEvents(req.query);
    const stats = activityTracker.getStats(liveState.playerCount);
    res.json({ events, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/players (active & known player registry with IPs — Admin Only) ─
app.get('/api/players', requireAdmin, async (req, res) => {
  try {
    await activityTracker.refreshClientSockets().catch(() => {});
    const players = activityTracker.getPlayers(liveState.players);
    res.json({ players });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/activity/clear (clear log history — Admin Only) ───────────────
app.post('/api/activity/clear', requireAdmin, (req, res) => {
  try {
    const result = activityTracker.clearEvents();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/activity/export (export JSON / CSV — Admin Only) ──────────────
app.get('/api/activity/export', requireAdmin, (req, res) => {
  try {
    const format = req.query.format || 'json';
    const events = activityTracker.getEvents({ limit: 5000 });
    if (format === 'csv') {
      const header = 'Timestamp,Date,Player,IP,Type,Severity,Title,Details\n';
      const rows = events.map(e => 
        `"${e.timestamp}","${e.dateStr}","${(e.player||'').replace(/"/g, '""')}","${(e.ip||'').replace(/"/g, '""')}","${e.type}","${e.severity}","${(e.title||'').replace(/"/g, '""')}","${(e.details||'').replace(/"/g, '""')}"`
      ).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="valheim-activity-audit.csv"');
      return res.send(header + rows);
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="valheim-activity-audit.json"');
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Fallback → serve index.html ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Bind on all interfaces so it's reachable via the server's public IP
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚔️  Valheim Admin Panel`);
  console.log(`   Local:     http://localhost:${PORT}`);
  console.log(`   Network:   http://<server-ip>:${PORT}`);
  console.log(`   Container: ${VALHEIM_CONTAINER}`);
  console.log(`   Admin:     ${ADMIN_USERNAME} / ${ADMIN_PASSWORD_PLAIN} (Full Access)`);
  console.log(`   User:      ${USER_USERNAME} / ${USER_PASSWORD_PLAIN} (Dashboard Only)\n`);

  // Initialize activity tracker with broadcast callback
  activityTracker.init({
    containerName: VALHEIM_CONTAINER,
    dockerCmd,
    onNewEvent: (event) => broadcastActivity(event)
  });

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

