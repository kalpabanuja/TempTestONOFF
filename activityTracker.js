/**
 * ═══════════════════════════════════════════════════════════════
 * Valheim User Activity & Security Audit Engine
 * ═══════════════════════════════════════════════════════════════
 * - Tracks connected players, IP addresses, and platform IDs
 * - Ingests server events (joins, leaves, deaths, in-game actions)
 * - Flags suspicious activities (PlayFab drops, rapid reconnects, errors)
 * - Enforces strict 14-day (2 weeks) maximum log history retention
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STORAGE_FILE = path.join(DATA_DIR, 'user_activity.json');

// 14 days retention in milliseconds
const RETENTION_DAYS = 14;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Helper: Clean and normalize player character names (strips trailing auxiliary verbs like ' has')
function cleanPlayerName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/\s+(?:has|have|is|was|had)$/i, '')
    .trim();
}

// Helper: Extract location coordinates like "(120.5, 34.2, -450.0)" or "at (120, 34, -450)"
function extractLocation(text) {
  if (!text || typeof text !== 'string') return { cleanText: text || '', location: null };
  const m = text.match(/(?:at|pos:?|coordinates:?|location:?|@)?\s*(\(-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?(?:,\s*-?\d+(?:\.\d+)?)?\))/i);
  if (m) {
    const loc = m[1];
    const clean = text.replace(m[0], '').replace(/\s{2,}/g, ' ').trim();
    return { cleanText: clean, location: loc };
  }
  return { cleanText: text, location: null };
}

// Helper: Validate whether a string is a genuine player character name
function isValidPlayer(name) {
  if (!name || typeof name !== 'string') return false;
  const clean = name.trim();
  const lower = clean.toLowerCase();
  if (lower.length < 2 || lower.length > 30) return false;

  // Strict blacklist of non-player / system / event / mod identifiers
  if (
    lower === 'server' ||
    lower === 'valheim' ||
    lower === 'mod' ||
    lower === 'discordconnector' ||
    lower === 'discord' ||
    lower === 'system' ||
    lower === 'world' ||
    lower === 'event' ||
    lower === 'events' ||
    lower === 'raid' ||
    lower === 'raids' ||
    lower === 'security alert' ||
    lower === 'security system' ||
    lower === 'connected viking' ||
    lower === '0:0' ||
    lower === '<null>' ||
    lower === 'null' ||
    lower === 'undefined' ||
    lower === 'unknown' ||
    lower === 'error' ||
    lower === 'warn' ||
    lower === 'warning' ||
    lower === 'info' ||
    lower === 'notice' ||
    lower === 'day' ||
    lower === 'days' ||
    lower === 'backup' ||
    lower === 'bepinex' ||
    lower === 'network' ||
    lower === 'admin' ||
    lower === 'administrator' ||
    lower === 'console' ||
    lower === 'broadcast' ||
    lower.startsWith('playfab/') ||
    lower.startsWith('steam/') ||
    lower.startsWith('client (') ||
    lower.startsWith('event:') ||
    lower.startsWith('world event:')
  ) {
    return false;
  }
  return true;
}

class ActivityTracker {
  constructor() {
    this.events = [];
    this.players = {}; // { [playerName]: { name, ip, platformId, status, firstSeen, lastSeen, sessionCount } }
    this.saveTimeout = null;
    this.recentConnections = []; // [{ player, timestamp }] for detecting rapid reconnect loops
    this.activeSockets = new Set(); // cached UDP client remote IPs
    this.lastObservedIp = null;
    this.containerName = 'valheim';
    this.dockerCmdFn = null;
    this.onNewEventCallback = null;
    this.peerToName = new Map(); // PeerID -> PlayerName
    this.currentlyOnline = new Set(); // Set of currently active character names
    this.pendingZdoZero = new Map(); // PlayerName -> { timestamp, raw }
    this.lastParsedTimestamp = null;
  }

  init({ containerName, dockerCmd, onNewEvent }) {
    this.containerName = containerName || 'valheim';
    this.dockerCmdFn = dockerCmd || null;
    this.onNewEventCallback = onNewEvent || null;

    // Ensure data directory exists
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
    } catch (err) {
      console.error('[activity] Error creating data directory:', err.message);
    }

    this.load();

    // Periodic prune every 1 hour to enforce 14-day limit
    setInterval(() => {
      this.prune();
      this.saveImmediate();
    }, 60 * 60 * 1000);

    // Initial IP socket refresh
    this.refreshClientSockets().catch(() => {});
  }

  // Gracefully end active player sessions when the server stops or restarts
  handleServerShutdown(timestamp = Date.now()) {
    for (const name of this.currentlyOnline) {
      this.setPlayerStatus(name, false, timestamp);
    }
    this.currentlyOnline.clear();
    this.pendingZdoZero.clear();
    for (const p of Object.values(this.players)) {
      if (p.status === 'online') {
        if (p.sessionStartTime) {
          const dur = Math.max(0, timestamp - p.sessionStartTime);
          p.totalUptimeMs = (p.totalUptimeMs || 0) + Math.min(dur, 14 * 3600 * 1000);
          p.sessionStartTime = null;
        }
        p.status = 'offline';
        p.lastSeen = Math.max(p.lastSeen || 0, timestamp);
      }
    }
    this.saveImmediate();
  }

  load() {
    try {
      if (fs.existsSync(STORAGE_FILE)) {
        const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
        const data = JSON.parse(raw);
        this.events = Array.isArray(data.events) ? data.events : [];
        this.players = typeof data.players === 'object' && data.players !== null ? data.players : {};

        // Scrub corrupted, dummy, or dirty players (e.g. 'EVENT', 'Test has', 'Mod', internal tags)
        for (const [key, val] of Object.entries(this.players)) {
          const cleaned = cleanPlayerName(key);
          if (!isValidPlayer(cleaned) || cleaned !== key) {
            delete this.players[key];
            if (isValidPlayer(cleaned) && !this.players[cleaned]) {
              val.name = cleaned;
              this.players[cleaned] = val;
            }
          }
        }

        // Clean past event player names and attribute system/event logs to 'World'
        for (const evt of this.events) {
          if (evt.player) {
            evt.player = cleanPlayerName(evt.player);
            if (!isValidPlayer(evt.player) && evt.player !== 'Server' && evt.player !== 'Mod') {
              evt.player = 'World';
            }
          }
        }

        // Scrub duplicate dummy leave events and false-positive Unauthorized Access events
        this.events = this.events.filter(
          (e) =>
            e.player !== 'Connected Viking' &&
            !(e.player && e.player.startsWith('playfab/')) &&
            !(e.title === 'Unauthorized Access Blocked' && /checking for any blocked players/i.test(e.details || e.raw || ''))
        );

        // Close any orphaned online sessions left behind from an ungraceful server shutdown or crash
        for (const p of Object.values(this.players)) {
          if (p.status === 'online') {
            if (p.sessionStartTime && p.lastSeen && p.lastSeen >= p.sessionStartTime) {
              const dur = Math.max(0, p.lastSeen - p.sessionStartTime);
              p.totalUptimeMs = (p.totalUptimeMs || 0) + Math.min(dur, 14 * 3600 * 1000);
            }
            p.status = 'offline';
            p.sessionStartTime = null;
          }
        }
        this.currentlyOnline.clear();

        console.log(`[activity] Loaded ${this.events.length} historical events and ${Object.keys(this.players).length} players.`);
        this.recalculateAllStats();
      }
    } catch (err) {
      console.warn('[activity] Failed to read activity storage, starting fresh:', err.message);
      this.events = [];
      this.players = {};
    }

    // Immediately prune anything older than 14 days
    this.prune();
  }

  prune() {
    const cutoff = Date.now() - RETENTION_MS;
    const initialCount = this.events.length;
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
    if (this.events.length < initialCount) {
      console.log(`[activity] Pruned ${initialCount - this.events.length} events older than 14 days.`);
    }
  }

  save() {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.saveImmediate(), 1000);
  }

  saveImmediate() {
    try {
      this.prune();
      const payload = {
        updatedAt: new Date().toISOString(),
        retentionDays: RETENTION_DAYS,
        players: this.players,
        events: this.events.slice(-5000), // safety ceiling to keep file fast
      };
      fs.writeFileSync(STORAGE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.error('[activity] Error writing to user_activity.json:', err.message);
    }
  }

  // Poll UDP sockets inside container to discover connected client IPs
  async refreshClientSockets() {
    if (!this.dockerCmdFn) return [];
    try {
      // ss command inside container or netstat
      const out = await this.dockerCmdFn(`exec ${this.containerName} sh -c "ss -un sport = :2456 2>/dev/null || ss -un 2>/dev/null || netstat -un 2>/dev/null"`).catch(() => '');
      const lines = out.split('\n');
      const foundIps = new Set();

      for (const line of lines) {
        // match IP:PORT e.g. 203.0.113.45:54122
        const m = line.match(/\s+([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}):[0-9]+\s*$/);
        if (m) {
          const ip = m[1];
          // Skip loopback, wildcard, and Docker internal bridge (172.17.x / 172.18.x)
          if (ip !== '0.0.0.0' && ip !== '127.0.0.1' && !ip.startsWith('172.17.') && !ip.startsWith('172.18.')) {
            foundIps.add(ip);
            this.lastObservedIp = ip;
          }
        }
      }

      this.activeSockets = foundIps;
      return Array.from(foundIps);
    } catch (_) {
      return [];
    }
  }

  // Update or register a player record
  registerPlayer(name, { ip = null, platformId = null, online = true, timestamp = Date.now() } = {}) {
    if (!name || name === '0:0' || name === '<null>') return;
    const cleanName = cleanPlayerName(name);

    // Prevent internal server tags, socket strings, or dummy names from creating player records
    if (!isValidPlayer(cleanName)) {
      return;
    }

    if (online) {
      this.currentlyOnline.add(cleanName);
    } else {
      this.currentlyOnline.delete(cleanName);
    }

    if (!this.players[cleanName]) {
      this.players[cleanName] = {
        name: cleanName,
        ip: ip || (this.lastObservedIp || 'Direct Connect'),
        platformId: platformId || 'Unknown',
        status: online ? 'online' : 'offline',
        firstSeen: timestamp,
        lastSeen: timestamp,
        sessionCount: 1,
        totalUptimeMs: 0,
        sessionStartTime: online ? timestamp : null,
        deaths: 0,
        kills: 0,
        builds: 0,
        harvests: 0,
        pickups: 0,
        pings: 0,
        shouts: 0,
        killsBreakdown: {},
        buildsBreakdown: {},
        harvestsBreakdown: {},
        lastLocation: null,
        lastDeathCause: null,
        lastDeathLocation: null,
      };
    } else {
      const p = this.players[cleanName];
      this.ensurePlayerStats(p);
      if (ip && ip !== 'Direct Connect') p.ip = ip;
      if (platformId && platformId !== 'Unknown') p.platformId = platformId;
      if (online && p.status !== 'online') {
        p.sessionStartTime = timestamp;
        p.sessionCount = (p.sessionCount || 0) + 1;
      }
      p.status = online ? 'online' : p.status;
      p.lastSeen = Math.max(p.lastSeen || 0, timestamp);
    }

    this.save();
  }

  setPlayerStatus(name, online, timestamp = Date.now()) {
    if (!name) return;
    const cleanName = cleanPlayerName(name);
    if (!isValidPlayer(cleanName)) return;

    if (online) {
      this.currentlyOnline.add(cleanName);
    } else {
      this.currentlyOnline.delete(cleanName);
    }

    if (this.players[cleanName]) {
      const p = this.players[cleanName];
      this.ensurePlayerStats(p);
      if (online) {
        if (p.status !== 'online') {
          p.sessionStartTime = timestamp;
          p.sessionCount = (p.sessionCount || 0) + 1;
        }
        p.status = 'online';
      } else {
        if (p.sessionStartTime) {
          const dur = Math.max(0, timestamp - p.sessionStartTime);
          p.totalUptimeMs = (p.totalUptimeMs || 0) + Math.min(dur, 14 * 3600 * 1000);
          p.sessionStartTime = null;
        }
        p.status = 'offline';
      }
      p.lastSeen = Math.max(p.lastSeen || 0, timestamp);
      this.save();
    }
  }

  // Record an event with 14-day enforcement and deduplication
  recordEvent({
    player = 'System',
    ip = null,
    type = 'info', // 'join', 'leave', 'death', 'action', 'suspicious'
    severity = 'info', // 'info', 'warn', 'danger'
    title = '',
    details = '',
    location = null,
    raw = '',
    timestamp = Date.now(),
  }) {
    // Enforce 14-day limit: don't record if already expired
    if (timestamp < Date.now() - RETENTION_MS) return null;

    // Deduplicate identical events within 2 seconds BEFORE updating stats
    const recentDup = this.events.find(
      (e) =>
        e.player === player &&
        e.title === title &&
        Math.abs(e.timestamp - timestamp) < 2000
    );
    if (recentDup) return recentDup;

    // Use player's registered IP if not supplied
    if (!ip && player && this.players[player]) {
      ip = this.players[player].ip;
    }
    if (!ip && this.lastObservedIp) {
      ip = this.lastObservedIp;
    }

    // Update player profile statistics (only for accepted, non-duplicate events)
    if (player && this.players[player]) {
      const p = this.players[player];
      this.ensurePlayerStats(p);
      if (location) p.lastLocation = location;

      if (type === 'death') {
        p.deaths = (p.deaths || 0) + 1;
        if (details) p.lastDeathCause = details;
        if (location) p.lastDeathLocation = location;
      } else if (title === 'Creature Slayed') {
        p.kills = (p.kills || 0) + 1;
        const km = (details || '').match(/Defeated (.+?) in combat/i);
        if (km) {
          const t = km[1].trim();
          p.killsBreakdown = p.killsBreakdown || {};
          p.killsBreakdown[t] = (p.killsBreakdown[t] || 0) + 1;
        }
      } else if (title === 'Structure Placed') {
        p.builds = (p.builds || 0) + 1;
        const bm = (details || '').match(/Built\/placed: (.+?)\./i);
        if (bm) {
          const it = bm[1].trim();
          p.buildsBreakdown = p.buildsBreakdown || {};
          p.buildsBreakdown[it] = (p.buildsBreakdown[it] || 0) + 1;
        }
      } else if (title === 'Resource Harvested') {
        p.harvests = (p.harvests || 0) + 1;
        const hm = (details || '').match(/Harvested: (.+?)\./i);
        if (hm) {
          const r = hm[1].trim();
          p.harvestsBreakdown = p.harvestsBreakdown || {};
          p.harvestsBreakdown[r] = (p.harvestsBreakdown[r] || 0) + 1;
        }
      } else if (title === 'Map Ping') {
        p.pings = (p.pings || 0) + 1;
      } else if (title === 'World Shout / Chat') {
        p.shouts = (p.shouts || 0) + 1;
      }
    }

    const event = {
      id: `evt_${timestamp}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp,
      dateStr: new Date(timestamp).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }),
      player: player || 'System',
      ip: ip || 'Direct / Relay',
      type,
      severity,
      title,
      details,
      location: location || null,
      raw: (raw || '').slice(0, 300),
    };

    this.events.unshift(event); // newest first

    // Keep events array within bounds
    if (this.events.length > 5000) {
      this.events = this.events.slice(0, 5000);
    }

    this.save();

    if (typeof this.onNewEventCallback === 'function') {
      try {
        this.onNewEventCallback(event);
      } catch (_) {}
    }

    return event;
  }

  // Check for rapid reconnect loop from same player/session (suspicious activity)
  checkReconnectSpam(playerName, timestamp = Date.now()) {
    if (!playerName || playerName === 'System') return;
    const now = timestamp;
    this.recentConnections.push({ player: playerName, timestamp: now });
    // Filter connections in last 90 seconds
    this.recentConnections = this.recentConnections.filter((c) => now - c.timestamp <= 90000);

    const count = this.recentConnections.filter((c) => c.player === playerName).length;
    if (count >= 4) {
      this.recordEvent({
        player: playerName,
        type: 'suspicious',
        severity: 'danger',
        title: 'Rapid Reconnect Spam Detected',
        details: `Player "${playerName}" connected/reconnected ${count} times within 90 seconds. Potential connection loop or network desync.`,
        timestamp: now,
      });
    }
  }

  // Parse a timestamp from docker log lines (ISO, Syslog, or "MM/DD/YYYY HH:MM:SS")
  parseTimestamp(line) {
    if (!line || typeof line !== 'string') return this.lastParsedTimestamp || Date.now();

    // 1. Docker ISO timestamp: 2026-10-12T15:47:28.481511113Z
    const isoMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/);
    if (isoMatch) {
      let isoStr = isoMatch[1];
      if (!isoStr.endsWith('Z')) isoStr += 'Z';
      const ms = Date.parse(isoStr);
      if (!isNaN(ms)) {
        this.lastParsedTimestamp = ms;
        return ms;
      }
    }

    // 2. Syslog timestamp from supervisord: Oct 14 07:29:24
    const syslogMatch = line.match(/(?:^|\s)(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/i);
    if (syslogMatch) {
      const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
      const mIdx = months[syslogMatch[1].toLowerCase()];
      const day = parseInt(syslogMatch[2], 10);
      const year = new Date().getFullYear();
      const h = parseInt(syslogMatch[3], 10);
      const min = parseInt(syslogMatch[4], 10);
      const s = parseInt(syslogMatch[5], 10);
      const ms = new Date(year, mIdx, day, h, min, s).getTime();
      if (!isNaN(ms)) {
        this.lastParsedTimestamp = ms;
        return ms;
      }
    }

    // 3. Valheim in-game format: 10/12/2026 15:47:28:
    const valheimMatch = line.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (valheimMatch) {
      const [_, m, d, y, h, min, s] = valheimMatch;
      const ms = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s)).getTime();
      if (!isNaN(ms)) {
        this.lastParsedTimestamp = ms;
        return ms;
      }
    }

    // If this line lacks a timestamp, inherit the last parsed timestamp from this log stream
    // to prevent artificial jumps to Date.now() when backfilling historical records!
    return this.lastParsedTimestamp || Date.now();
  }

  // ─── Core Log Parser ────────────────────────────────────────────────────────
  processLogLine(rawLine, forcedTimestamp = null) {
    if (!rawLine || typeof rawLine !== 'string') return null;
    const line = rawLine.trim();
    if (!line) return null;

    const timestamp = forcedTimestamp || this.parseTimestamp(line);

    // 0. Server start / restart detected — reset session states
    if (/DungeonDB Start|Game server connected|Valheim version/i.test(line)) {
      for (const p of Object.values(this.players)) {
        p.status = 'offline';
      }
      this.currentlyOnline.clear();
      this.peerToName.clear();
      if (this.pendingZdoZero) this.pendingZdoZero.clear();
      this.save();
      return null;
    }

    // 1. PlayFab Error 4098 / Handle Invalidation (SUSPICIOUS / DANGER)
    if (/PlayFab network error.*code\s*'4098'|Failed to send,\s*suspend TX on playfab/i.test(line)) {
      const matchPlayer = line.match(/session\s*'([^']+)'/i) || line.match(/playfab\/([A-Za-z0-9]+)/i);
      const affected = matchPlayer ? matchPlayer[1] : 'PlayFab Client';

      return this.recordEvent({
        player: affected,
        type: 'suspicious',
        severity: 'danger',
        title: 'PlayFab Network Error 4098',
        details: 'Operation called with invalid handle. TX network socket suspended while attempting reconnect.',
        raw: line,
        timestamp,
      });
    }

    // 2. Generic PlayFab / Steam Network Failure (SUSPICIOUS)
    if (/PlayFab network error|SocketException|k_ESteamNetworkingAvailability_Failed/i.test(line)) {
      return this.recordEvent({
        player: 'Network',
        type: 'suspicious',
        severity: 'warn',
        title: 'Network Socket Error',
        details: line.slice(0, 200),
        raw: line,
        timestamp,
      });
    }

    // 3. Got character ZDOID:
    // Format: "Got character ZDOID from <CharacterName> : <PeerID>:<ZDOID>"
    // Case A: Death -> "Got character ZDOID from <CharacterName> : 0:0"
    // Case B: Spawn / Respawn -> "Got character ZDOID from <CharacterName> : 1695201500:2"
    const zdoidMatch = line.match(/Got character ZDOID from\s+(.+?)\s*:\s*([-0-9]+):([-0-9]+)/i);
    if (zdoidMatch) {
      const name = zdoidMatch[1].trim();
      const peerId = zdoidMatch[2].trim();
      const zdoid = zdoidMatch[3].trim();

      // Case A: ZDOID reset (0:0) -> Character despawn on death OR logout
      if (peerId === '0' && zdoid === '0') {
        if (isValidPlayer(name)) {
          this.pendingZdoZero.set(name, { timestamp, raw: line });
        }
        return null;
      }

      // Case B: Character Spawn or Respawn
      if (!isValidPlayer(name)) {
        return null;
      }

      if (peerId && peerId !== '0') {
        this.peerToName.set(peerId, name);
      }

      const isAlreadyOnline = this.currentlyOnline.has(name);
      this.currentlyOnline.add(name);
      this.registerPlayer(name, { online: true, timestamp });

      // Check if this spawn is a RESPAWN after death (pending 0:0 confirmed by subsequent respawn)
      if (this.pendingZdoZero && this.pendingZdoZero.has(name)) {
        const pending = this.pendingZdoZero.get(name);
        this.pendingZdoZero.delete(name);

        return this.recordEvent({
          player: name,
          type: 'death',
          severity: 'warn',
          title: 'Viking Fallen in Battle',
          details: `${name} perished in battle and respawned.`,
          raw: pending.raw || line,
          timestamp: pending.timestamp || timestamp,
        });
      }

      if (isAlreadyOnline) {
        // Player is already online: respawn after death or portal teleport.
        // Do NOT log a duplicate "Viking Joined Realm" join event!
        return null;
      }

      this.checkReconnectSpam(name, timestamp);

      return this.recordEvent({
        player: name,
        type: 'join',
        severity: 'info',
        title: 'Viking Joined Realm',
        details: `Character spawned into world (Peer: ${peerId}, ZDOID: ${zdoid}).`,
        raw: line,
        timestamp,
      });
    }

    // 4. In-Game Modded / Combat Death ("Player <Name> died" / "slain by")
    // NOTE: Use .+? (lazy) for player name to allow spaces; anchor with specific verb phrases
    const slainMatch = line.match(/(?:Player\s+)?(.+?)\s+(?:was killed by|died to|was slain by|fell victim to|has died|died|drowned)\s*(.*)/i);
    if (slainMatch) {
      const name = slainMatch[1].trim();
      const killer = (slainMatch[2] || '').trim();
      // Guard against false positives on Valheim internal lines
      if (name.length >= 2 && !name.startsWith('playfab/') && !name.startsWith('steam/') && isValidPlayer(name)) {
        this.registerPlayer(name, { online: true, timestamp });
        if (this.pendingZdoZero) this.pendingZdoZero.delete(name);
        return this.recordEvent({
          player: name,
          type: 'death',
          severity: 'warn',
          title: 'Killed by Creature / Trap',
          details: killer ? `Slain by ${killer}.` : `${name} perished in battle.`,
          raw: line,
          timestamp,
        });
      }
    }

    // 5. Disconnect via abandoned non-persistent ZDO (maps owner PeerID directly to character)
    const abandonedZdoMatch = line.match(/Destroying abandoned non persistent zdo\s+[-0-9:]+\s+owner\s+([-0-9]+)/i);
    if (abandonedZdoMatch) {
      const ownerPeerId = abandonedZdoMatch[1].trim();
      const playerName = this.peerToName.get(ownerPeerId);

      if (playerName) {
        // It was a logout/disconnect, clear any pending 0:0 so it isn't treated as a death
        if (this.pendingZdoZero) this.pendingZdoZero.delete(playerName);

        if (this.currentlyOnline.has(playerName)) {
          this.currentlyOnline.delete(playerName);
          this.setPlayerStatus(playerName, false, timestamp);

          return this.recordEvent({
            player: playerName,
            type: 'leave',
            severity: 'info',
            title: 'Viking Departed Realm',
            details: `${playerName} disconnected from the realm.`,
            raw: line,
            timestamp,
          });
        }
      }
      return null;
    }

    // Authoritative "Player connection lost server ... now 0 player(s)"
    const connLostMatch = line.match(/Player connection lost server .* now\s+(\d+)\s+player\(s\)/i);
    if (connLostMatch) {
      const remainingCount = parseInt(connLostMatch[1], 10);
      if (remainingCount === 0) {
        if (this.pendingZdoZero) this.pendingZdoZero.clear();
        for (const p of this.currentlyOnline) {
          this.setPlayerStatus(p, false, timestamp);
        }
        this.currentlyOnline.clear();
      }
      return null;
    }

    // 6. World Events: Raids
    const raidStartMatch = line.match(/Random event '([^']+)' started|Random event set:([a-zA-Z0-9_]+)/i);
    if (raidStartMatch) {
      const eventName = raidStartMatch[1] || raidStartMatch[2];
      return this.recordEvent({
        player: 'World',
        type: 'action',
        severity: 'warn',
        title: 'Raid Event Started',
        details: `A world event has begun: "${eventName}".`,
        raw: line,
        timestamp,
      });
    }

    const raidEndMatch = line.match(/Random event '([^']+)' ended/i);
    if (raidEndMatch) {
      const eventName = raidEndMatch[1];
      return this.recordEvent({
        player: 'World',
        type: 'action',
        severity: 'info',
        title: 'Raid Event Ended',
        details: `World event "${eventName}" has ended.`,
        raw: line,
        timestamp,
      });
    }

    // 7. World Save
    const worldSaveMatch = line.match(/World saved\s*\(\s*([0-9.]+\s*ms)\s*\)/i);
    if (worldSaveMatch) {
      return this.recordEvent({
        player: 'World',
        type: 'info',
        severity: 'info',
        title: 'World Saved',
        details: `Game world state written to disk (${worldSaveMatch[1]}).`,
        raw: line,
        timestamp,
      });
    }

    // 8. Handshake detection (capture client IP without creating dummy player)
    const handshakeMatch = line.match(/Got handshake from client\s+([A-Za-z0-9_/-]+)/i);
    if (handshakeMatch) {
      this.refreshClientSockets().catch(() => {});
      return null; // Don't create dummy player card for playfab/... or steam/...
    }

    // 9. World Chat / Shout: "<Player> message" or "Player shouts: message"
    const chatMatch = line.match(/^(?:<([A-Za-z0-9_ ]+)>|([A-Za-z0-9_ ]+)\s*(?:shouts|says|whispers):\s*)(.+)/i);
    if (chatMatch) {
      const sender = (chatMatch[1] || chatMatch[2] || '').trim();
      const message = (chatMatch[3] || '').trim();
      if (sender && !sender.toLowerCase().includes('server') && !sender.toLowerCase().includes('valheim')) {
        this.registerPlayer(sender, { online: true, timestamp });
        return this.recordEvent({
          player: sender,
          type: 'action',
          severity: 'info',
          title: 'World Shout / Chat',
          details: `"${message}"`,
          raw: line,
          timestamp,
        });
      }
    }

    // 10. Banned or Unauthorized access attempts (SUSPICIOUS)
    // NOTE: Ignore routine Valheim checks like "Checking for any blocked players in the historical player list..."
    if (
      !/checking for any blocked players|blocked players in the historical/i.test(line) &&
      /(?:is\s+banned|banned\s+player|not\s+in\s+(?:the\s+)?whitelist|kicking:.*whitelist|blocked\s+connection)/i.test(line)
    ) {
      return this.recordEvent({
        player: 'Security System',
        type: 'suspicious',
        severity: 'danger',
        title: 'Unauthorized Access Blocked',
        details: line.slice(0, 200),
        raw: line,
        timestamp,
      });
    }

    // 13. Item Spawns & Console Cheats (SUSPICIOUS)
    const spawnMatch = line.match(/(?:Player\s+)?([A-Za-z0-9_]+)\s+(?:spawned|used console to spawn|cheated|spawn command:)\s+(.+)/i);
    if (spawnMatch) {
      const name = spawnMatch[1].trim();
      const item = spawnMatch[2].trim();
      this.registerPlayer(name, { online: true, timestamp });
      return this.recordEvent({
        player: name,
        type: 'suspicious',
        severity: 'danger',
        title: 'Item Spawn / Cheat Detected',
        details: `Spawned: ${item}`,
        raw: line,
        timestamp,
      });
    }

    // 14. ServerCharacters / AntiCheat Foreign Item Alerts (SUSPICIOUS)
    if (/AntiCheat|ServerCharacters|Illegal item|Foreign item|Inventory mismatch|blocked spawn|Cheat detected/i.test(line)) {
      const matchPlayer = line.match(/(?:Player|from|character)\s+([A-Za-z0-9_]+)/i);
      const player = matchPlayer ? matchPlayer[1] : 'Security Alert';
      return this.recordEvent({
        player,
        type: 'suspicious',
        severity: 'danger',
        title: 'Foreign Item / AntiCheat Violation',
        details: line.slice(0, 250),
        raw: line,
        timestamp,
      });
    }

    return null;
  }

  // Ingest events from DiscordConnector or other BepInEx webhooks
  ingestModMessage({ rawMessage, author, title, location: explicitLoc, raw }) {
    if (!rawMessage) return null;
    const timestamp = Date.now();
    const rawTrimmed = rawMessage.trim();
    const { cleanText, location: extractedLoc } = extractLocation(rawTrimmed);
    const location = explicitLoc || extractedLoc || null;
    const text = cleanText || rawTrimmed;

    // Determine fallback player identity from webhook author/sender
    const fallbackPlayer = cleanPlayerName(author || '');
    const defaultPlayer = isValidPlayer(fallbackPlayer) ? fallbackPlayer : null;

    const withLoc = (msg) => (location && !msg.includes(location) ? `${msg} at ${location}` : msg);

    // 1. Player Joined (e.g. "Kalpa has arrived!" or "has arrived!" with author "Kalpa")
    const joinMatch = text.match(/^(?:(.+?)\s+)?(?:has\s+|have\s+)?(?:arrived|joined(?:\s+the\s+(?:server|game))?|connected(?:\s+to\s+the\s+server)?)[!.]*$/i);
    if (joinMatch) {
      const candidate = (joinMatch[1] || defaultPlayer || '').trim();
      const player = cleanPlayerName(candidate);
      if (isValidPlayer(player)) {
        this.currentlyOnline.add(player);
        this.registerPlayer(player, { online: true, timestamp });
        return this.recordEvent({
          player,
          type: 'join',
          severity: 'info',
          title: 'Viking Joined Realm',
          details: withLoc(`${player} arrived in the realm.`),
          location,
          raw,
          timestamp,
        });
      }
    }

    // 2. Player Left (e.g. "Kalpa has left." or "has left" with author "Kalpa")
    const leaveMatch = text.match(/^(?:(.+?)\s+)?(?:has\s+|have\s+)?(?:left(?:\s+the\s+(?:server|game))?|disconnected(?:\s+from\s+the\s+server)?)[!.]*$/i);
    if (leaveMatch) {
      const candidate = (leaveMatch[1] || defaultPlayer || '').trim();
      const player = cleanPlayerName(candidate);
      if (isValidPlayer(player)) {
        this.currentlyOnline.delete(player);
        this.setPlayerStatus(player, false, timestamp);
        return this.recordEvent({
          player,
          type: 'leave',
          severity: 'info',
          title: 'Viking Departed Realm',
          details: withLoc(`${player} departed from the realm.`),
          location,
          raw,
          timestamp,
        });
      }
    }

    // 3. Player Death (DiscordConnector, DeathMessage, or webhooks)
    const isDeathTitle = /death|died|slain|fallen|perished|casualt/i.test(title || '');
    const deathRegex = /^(?:(.+?)\s+)?(?:has\s+|have\s+)?(?:died(?:\s+for\s+the\s+first\s+time)?|was\s+killed\s+by|died\s+to|was\s+slain\s+by|perished|succumbed(?:\s+to)?|fell\s+victim\s+to|drowned|suffocated|fell\s+from\s+a\s+high\s+place|burned\s+to\s+death|froze\s+to\s+death|met\s+an\s+untimely\s+demise)\s*(.*)/i;
    const deathMatch = text.match(deathRegex);

    if (deathMatch || isDeathTitle) {
      let candidate = deathMatch ? (deathMatch[1] || '').trim() : '';
      let cause = deathMatch ? (deathMatch[2] || '').trim() : '';

      // If candidate is empty or auxiliary verb, fallback to author/defaultPlayer
      if (!candidate || !isValidPlayer(cleanPlayerName(candidate))) {
        candidate = defaultPlayer || '';
        if (isDeathTitle && !cause) {
          cause = text;
        }
      }

      const player = cleanPlayerName(candidate);
      if (isValidPlayer(player)) {
        this.currentlyOnline.add(player);
        this.registerPlayer(player, { online: true, timestamp });
        if (this.pendingZdoZero) this.pendingZdoZero.delete(player);

        let deathDetails = `${player} died in battle.`;
        if (cause) {
          if (/^was\s+killed\s+by|^slain\s+by|^died\s+to/i.test(cause)) {
            deathDetails = `${player} ${cause}.`;
          } else if (/^by\s+/i.test(cause)) {
            deathDetails = `Slain ${cause}.`;
          } else {
            deathDetails = `Slain by ${cause}.`;
          }
        }

        return this.recordEvent({
          player,
          type: 'death',
          severity: 'warn',
          title: 'Viking Fallen in Battle',
          details: withLoc(deathDetails),
          location,
          raw,
          timestamp,
        });
      }
    }

    // 4. Map Ping — before chat so "pinged the map" doesn't get swallowed by chat
    const pingMatch = text.match(/^(?:(.+?)\s+)?pinged the map/i);
    if (pingMatch) {
      const candidate = (pingMatch[1] || defaultPlayer || '').trim();
      const player = cleanPlayerName(candidate);
      if (isValidPlayer(player)) {
        this.registerPlayer(player, { online: true, timestamp });
        return this.recordEvent({
          player,
          type: 'action',
          severity: 'info',
          title: 'Map Ping',
          details: withLoc(`${player} pinged coordinates on the world map.`),
          location,
          raw,
          timestamp,
        });
      }
    }

    // 5. Creature / Boss Kill (e.g. "Kalpa killed a Troll" or "Kalpa has killed a Troll")
    const creatureKillMatch = text.match(/^(?:(.+?)\s+)?(?:has\s+|have\s+)?(?:killed|slayed|slew|defeated|destroyed|slain)\s+(?:a |an |the )?(.+)/i);
    if (creatureKillMatch) {
      const candidate = (creatureKillMatch[1] || defaultPlayer || '').trim();
      const player = cleanPlayerName(candidate);
      const target = creatureKillMatch[2].replace(/[!.]+$/, '').trim();
      if (isValidPlayer(player)) {
        this.registerPlayer(player, { online: true, timestamp });
        return this.recordEvent({
          player,
          type: 'action',
          severity: 'info',
          title: 'Creature Slayed',
          details: withLoc(`Defeated ${target} in combat.`),
          location,
          raw,
          timestamp,
        });
      }
    }

    // 6. Build / Place events (e.g. "Kalpa placed a Workbench" or "Kalpa has built a Campfire")
    const buildMatch = text.match(/^(?:(.+?)\s+)?(?:has\s+|have\s+)?(?:placed|built|constructed|crafted|created)\s+(?:a |an |the )?(.+)/i);
    if (buildMatch) {
      const candidate = (buildMatch[1] || defaultPlayer || '').trim();
      const player = cleanPlayerName(candidate);
      const item = buildMatch[2].replace(/[!.]+$/, '').trim();
      if (isValidPlayer(player)) {
        this.registerPlayer(player, { online: true, timestamp });
        return this.recordEvent({
          player,
          type: 'action',
          severity: 'info',
          title: 'Structure Placed',
          details: withLoc(`Built/placed: ${item}.`),
          location,
          raw,
          timestamp,
        });
      }
    }

    // 7. Loot / Pickup events (e.g. "Kalpa picked up Coins x5" or "Kalpa has collected Wood")
    const pickupMatch = text.match(/^(?:(.+?)\s+)?(?:has\s+|have\s+)?(?:picked up|looted|collected|gathered|obtained|received|found)\s+(.+)/i);
    if (pickupMatch) {
      const candidate = (pickupMatch[1] || defaultPlayer || '').trim();
      const player = cleanPlayerName(candidate);
      const item = pickupMatch[2].replace(/[!.]+$/, '').trim();
      if (isValidPlayer(player)) {
        this.registerPlayer(player, { online: true, timestamp });
        return this.recordEvent({
          player,
          type: 'action',
          severity: 'info',
          title: 'Item Acquired',
          details: withLoc(`Picked up: ${item}.`),
          location,
          raw,
          timestamp,
        });
      }
    }

    // 8. Resource harvesting (e.g. "Kalpa mined Stone" or "Kalpa has chopped Oak")
    const harvestMatch = text.match(/^(?:(.+?)\s+)?(?:has\s+|have\s+)?(?:mined|harvested|chopped|cut down)\s+(.+)/i);
    if (harvestMatch) {
      const candidate = (harvestMatch[1] || defaultPlayer || '').trim();
      const player = cleanPlayerName(candidate);
      const resource = harvestMatch[2].replace(/[!.]+$/, '').trim();
      if (isValidPlayer(player)) {
        this.registerPlayer(player, { online: true, timestamp });
        return this.recordEvent({
          player,
          type: 'action',
          severity: 'info',
          title: 'Resource Harvested',
          details: withLoc(`Harvested: ${resource}.`),
          location,
          raw,
          timestamp,
        });
      }
    }

    // 9. World Event / Raid phrases or DiscordConnector Event prefix
    const eventPrefixMatch = text.match(/^(?:world\s+)?event:\s*(.+)/i);
    const raidRegex = /forest is moving|foul smell|cold wind|ground is shaking|army of|skeleton surprise|hunt|cauldron|sulfur|snowstorm|swarm|horde|what's up dog|event is paused|event has ended/i;

    if (eventPrefixMatch || raidRegex.test(text)) {
      const eventDetails = eventPrefixMatch ? eventPrefixMatch[1].trim() : text;
      return this.recordEvent({
        player: 'World',
        type: 'action',
        severity: 'warn',
        title: 'World Event / Raid',
        details: withLoc(eventDetails),
        location,
        raw,
        timestamp,
      });
    }

    // 10. Chat / Shout — comes LAST so specific action patterns above get priority
    const chatMatch = text.match(/^(.+?)\s+(?:shouts|says|whispers):\s*(.+)/i) ||
                      text.match(/^([A-Za-z0-9_\-\s]{2,25}):\s+"?(.+?)"?$/i);
    if (chatMatch) {
      const player = cleanPlayerName(chatMatch[1]);
      const chat = chatMatch[2].trim();
      if (isValidPlayer(player)) {
        this.currentlyOnline.add(player);
        this.registerPlayer(player, { online: true, timestamp });
        return this.recordEvent({
          player,
          type: 'action',
          severity: 'info',
          title: 'World Shout / Chat',
          details: withLoc(`"${chat.replace(/^"|"$/g, '')}"`),
          location,
          raw,
          timestamp,
        });
      }
    }

    // 11. Generic fallthrough — catch everything else from the mod
    const displayPlayer = defaultPlayer || 'Mod';
    return this.recordEvent({
      player: displayPlayer,
      type: 'action',
      severity: 'info',
      title: title || 'Server Event',
      details: withLoc(text),
      location,
      raw,
      timestamp,
    });
  }

  // Backfill history from existing container logs on startup
  backfillLogs(logContent) {
    if (!logContent) return;
    const lines = logContent.split('\n');
    console.log(`[activity] Ingesting recent logs (${lines.length} lines) into audit store...`);
    let count = 0;
    this.lastParsedTimestamp = null;
    for (const line of lines) {
      const evt = this.processLogLine(line);
      if (evt) count++;
    }
    console.log(`[activity] Backfill complete. Captured ${count} events.`);
    this.recalculateAllStats();
  }

  // Query events with rich filtering
  getEvents({ user, type, severity, timeRange, search, limit = 500 } = {}) {
    this.prune();
    let result = this.events;

    // Filter by specific user
    if (user && user !== 'all') {
      const lower = user.toLowerCase();
      result = result.filter(
        (e) => (e.player && e.player.toLowerCase() === lower) || (e.ip && e.ip.toLowerCase().includes(lower))
      );
    }

    // Filter by event type
    if (type && type !== 'all') {
      if (type === 'join_leave') {
        result = result.filter((e) => e.type === 'join' || e.type === 'leave');
      } else {
        result = result.filter((e) => e.type === type);
      }
    }

    // Filter by severity
    if (severity && severity !== 'all') {
      result = result.filter((e) => e.severity === severity);
    }

    // Filter by time range
    if (timeRange && timeRange !== '14d') {
      const now = Date.now();
      let msRange = RETENTION_MS;
      if (timeRange === '24h') msRange = 24 * 60 * 60 * 1000;
      else if (timeRange === '48h') msRange = 48 * 60 * 60 * 1000;
      else if (timeRange === '7d') msRange = 7 * 24 * 60 * 60 * 1000;
      result = result.filter((e) => now - e.timestamp <= msRange);
    }

    // Free text search
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (e) =>
          (e.player && e.player.toLowerCase().includes(q)) ||
          (e.ip && e.ip.toLowerCase().includes(q)) ||
          (e.title && e.title.toLowerCase().includes(q)) ||
          (e.details && e.details.toLowerCase().includes(q))
      );
    }

    return result.slice(0, Number(limit) || 500);
  }

  // Get list of all known players
  getPlayers(onlinePlayerNames = []) {
    const list = Object.values(this.players).map((p) => {
      let isOnline = false;
      if (Array.isArray(onlinePlayerNames) && onlinePlayerNames.length > 0) {
        isOnline = onlinePlayerNames.some((name) => name.toLowerCase() === p.name.toLowerCase());
      } else {
        isOnline = (this.currentlyOnline && this.currentlyOnline.has(p.name)) || p.status === 'online';
      }

      return {
        ...p,
        status: isOnline ? 'online' : 'offline',
      };
    });

    // Sort: Online first, then recently active
    return list.sort((a, b) => {
      if (a.status === 'online' && b.status !== 'online') return -1;
      if (b.status === 'online' && a.status !== 'online') return 1;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });
  }

  // Compute summary stats for dashboard cards
  getStats(onlineCount = 0) {
    const totalPlayers = Object.keys(this.players).length;
    const totalEvents = this.events.length;
    const suspiciousEvents = this.events.filter((e) => e.type === 'suspicious' || e.severity === 'danger').length;
    const computedOnline = typeof onlineCount === 'number' && onlineCount >= 0 
      ? onlineCount 
      : (this.currentlyOnline ? this.currentlyOnline.size : 0);

    return {
      totalPlayers,
      onlinePlayers: computedOnline,
      totalEvents,
      suspiciousEvents,
      retentionDays: RETENTION_DAYS,
    };
  }

  // Clear events history
  clearEvents() {
    this.events = [];
    this.saveImmediate();
    return { success: true, count: 0 };
  }

  // Ensure default stats structure exists on a player record
  ensurePlayerStats(p) {
    if (!p) return;
    if (typeof p.totalUptimeMs !== 'number') p.totalUptimeMs = 0;
    if (typeof p.deaths !== 'number') p.deaths = 0;
    if (typeof p.kills !== 'number') p.kills = 0;
    if (typeof p.builds !== 'number') p.builds = 0;
    if (typeof p.harvests !== 'number') p.harvests = 0;
    if (typeof p.pickups !== 'number') p.pickups = 0;
    if (typeof p.pings !== 'number') p.pings = 0;
    if (typeof p.shouts !== 'number') p.shouts = 0;
    if (!p.killsBreakdown) p.killsBreakdown = {};
    if (!p.buildsBreakdown) p.buildsBreakdown = {};
    if (!p.harvestsBreakdown) p.harvestsBreakdown = {};
    if (!p.lastLocation) p.lastLocation = null;
    if (!p.lastDeathCause) p.lastDeathCause = null;
    if (!p.lastDeathLocation) p.lastDeathLocation = null;
  }

  // Reset all tracked numeric counters and breakdowns on a single player record
  resetPlayerRecord(p) {
    if (!p) return;
    this.ensurePlayerStats(p);
    p.totalUptimeMs = 0;
    p.sessionStartTime = null;
    p.deaths = 0;
    p.kills = 0;
    p.builds = 0;
    p.harvests = 0;
    p.pickups = 0;
    p.pings = 0;
    p.shouts = 0;
    p.sessionCount = 0;
    p.killsBreakdown = {};
    p.buildsBreakdown = {};
    p.harvestsBreakdown = {};
    p.lastLocation = null;
    p.lastDeathCause = null;
    p.lastDeathLocation = null;
  }

  // Recalculates clean leaderboard statistics from verified events
  recalculateAllStats({ resetHistory = false } = {}) {
    if (resetHistory) {
      this.events = [];
      for (const p of Object.values(this.players)) {
        this.resetPlayerRecord(p);
        p.sessionCount = 1;
      }
      this.saveImmediate();
      console.log('[activity] All leaderboard stats and event history have been wiped to zero.');
      return;
    }

    const now = Date.now();

    // Purge any invalid players (like EVENT, World, Mod, etc.) from players list and active online set
    for (const pName of Object.keys(this.players)) {
      const clean = cleanPlayerName(pName);
      if (!isValidPlayer(clean) || clean !== pName) {
        delete this.players[pName];
        if (isValidPlayer(clean) && !this.players[clean]) {
          this.players[clean] = { name: clean };
        }
      }
    }
    this.currentlyOnline = new Set(Array.from(this.currentlyOnline).filter((n) => isValidPlayer(n)));

    // Clean past event players: re-attribute non-player event lines to 'World'
    for (const e of this.events) {
      if (e.player) {
        e.player = cleanPlayerName(e.player);
        if (!isValidPlayer(e.player) && e.player !== 'Server' && e.player !== 'Mod') {
          e.player = 'World';
        }
      }
    }

    // Reset counters and uptime for every known player
    for (const p of Object.values(this.players)) {
      this.resetPlayerRecord(p);
    }

    // Chronological replay of stored events (events stored newest-first, so sort ascending)
    const chronologicalEvents = this.events.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // Track active session start per player during replay
    const sessionStarts = new Map();

    for (const e of chronologicalEvents) {
      if (!e.player || !isValidPlayer(e.player)) continue;
      const cleanName = cleanPlayerName(e.player);
      if (!this.players[cleanName]) continue;
      const p = this.players[cleanName];

      const evtTime = typeof e.timestamp === 'number' && !isNaN(e.timestamp) ? e.timestamp : now;

      if (e.type === 'join') {
        p.sessionCount = (p.sessionCount || 0) + 1;
        sessionStarts.set(cleanName, evtTime);
        if (!p.firstSeen || evtTime < p.firstSeen) p.firstSeen = evtTime;
        p.lastSeen = Math.max(p.lastSeen || 0, evtTime);
      } else if (e.type === 'leave') {
        if (sessionStarts.has(cleanName)) {
          const joinTime = sessionStarts.get(cleanName);
          const duration = Math.max(0, evtTime - joinTime);
          // Cap single session at 14 hours to guard against runaway orphaned disconnects
          p.totalUptimeMs = (p.totalUptimeMs || 0) + Math.min(duration, 14 * 3600 * 1000);
          sessionStarts.delete(cleanName);
        }
        p.lastSeen = Math.max(p.lastSeen || 0, evtTime);
      } else if (e.type === 'death') {
        p.deaths = (p.deaths || 0) + 1;
        if (e.details) p.lastDeathCause = e.details;
        if (e.location) p.lastDeathLocation = e.location;
        p.lastSeen = Math.max(p.lastSeen || 0, evtTime);
      } else if (e.title === 'Creature Slayed') {
        p.kills = (p.kills || 0) + 1;
        const m = (e.details || '').match(/Defeated (.+?) in combat/i);
        if (m) {
          const t = m[1].trim();
          p.killsBreakdown = p.killsBreakdown || {};
          p.killsBreakdown[t] = (p.killsBreakdown[t] || 0) + 1;
        }
        p.lastSeen = Math.max(p.lastSeen || 0, evtTime);
      } else if (e.title === 'Structure Placed') {
        p.builds = (p.builds || 0) + 1;
        const m = (e.details || '').match(/Built\/placed: (.+?)\./i);
        if (m) {
          const it = m[1].trim();
          p.buildsBreakdown = p.buildsBreakdown || {};
          p.buildsBreakdown[it] = (p.buildsBreakdown[it] || 0) + 1;
        }
        p.lastSeen = Math.max(p.lastSeen || 0, evtTime);
      } else if (e.title === 'Resource Harvested') {
        p.harvests = (p.harvests || 0) + 1;
        const m = (e.details || '').match(/Harvested: (.+?)\./i);
        if (m) {
          const r = m[1].trim();
          p.harvestsBreakdown = p.harvestsBreakdown || {};
          p.harvestsBreakdown[r] = (p.harvestsBreakdown[r] || 0) + 1;
        }
        p.lastSeen = Math.max(p.lastSeen || 0, evtTime);
      } else if (e.title === 'Map Ping') {
        p.pings = (p.pings || 0) + 1;
      } else if (e.title === 'World Shout / Chat') {
        p.shouts = (p.shouts || 0) + 1;
      }

      if (e.location) {
        p.lastLocation = e.location;
      }
    }

    // Final sanity check & session state restoration for each player
    for (const p of Object.values(this.players)) {
      if (!p.sessionCount || p.sessionCount < 1) p.sessionCount = 1;

      const isOnline = this.currentlyOnline && this.currentlyOnline.has(p.name);
      p.status = isOnline ? 'online' : 'offline';

      if (isOnline) {
        p.sessionStartTime = sessionStarts.get(p.name) || now;
      } else {
        p.sessionStartTime = null;
      }

      // Mathematical sanity cap: Total uptime cannot exceed the time elapsed since the player was first seen
      if (p.firstSeen && p.firstSeen <= now) {
        const maxPossibleUptime = Math.max(0, now - p.firstSeen);
        if (p.totalUptimeMs > maxPossibleUptime) {
          console.warn(`[activity] Clamping impossible uptime for ${p.name} from ${p.totalUptimeMs}ms down to ${maxPossibleUptime}ms.`);
          p.totalUptimeMs = maxPossibleUptime;
        }
      }

      if (typeof p.totalUptimeMs !== 'number' || isNaN(p.totalUptimeMs) || p.totalUptimeMs < 0) {
        p.totalUptimeMs = 0;
      }
    }

    console.log(`[activity] Recalculated leaderboard stats across ${Object.keys(this.players).length} players.`);
    this.saveImmediate();
  }

  // Get full leaderboard data (Public & Admin)
  getLeaderboard() {
    const now = Date.now();
    const playersList = Object.values(this.players)
      .filter((p) => p && isValidPlayer(p.name))
      .map((p) => {
      this.ensurePlayerStats(p);
      let uptimeMs = p.totalUptimeMs || 0;
      const isOnline = (this.currentlyOnline && this.currentlyOnline.has(p.name));
      if (isOnline && p.sessionStartTime) {
        const liveSession = Math.max(0, now - p.sessionStartTime);
        uptimeMs += Math.min(liveSession, 14 * 3600 * 1000);
      }

      // Mathematical sanity cap: Total uptime cannot exceed age of player record
      if (p.firstSeen && p.firstSeen <= now) {
        uptimeMs = Math.min(uptimeMs, Math.max(0, now - p.firstSeen));
      }

      const totalMinutes = Math.floor(uptimeMs / 60000);
      const hours = Math.floor(totalMinutes / 60);
      const mins = totalMinutes % 60;
      const uptimeFormatted = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

      const kills = p.kills || 0;
      const deaths = p.deaths || 0;
      const kdRatio = deaths > 0 ? (kills / deaths).toFixed(1) : kills.toFixed(0);

      // Score formula: kills (x10) + builds (x3) + harvests (x2) + hours (x5) - deaths (x2)
      const score = Math.max(0, (kills * 10) + ((p.builds || 0) * 3) + ((p.harvests || 0) * 2) + (hours * 5) - (deaths * 2));

      return {
        name: p.name,
        status: isOnline ? 'online' : 'offline',
        uptimeMs,
        uptimeFormatted,
        sessionCount: p.sessionCount || 1,
        firstSeen: p.firstSeen || p.lastSeen || now,
        lastSeen: p.lastSeen || now,
        kills,
        deaths,
        kdRatio,
        lastDeathCause: p.lastDeathCause || null,
        lastLocation: p.lastLocation || null,
        builds: p.builds || 0,
        harvests: p.harvests || 0,
        pickups: p.pickups || 0,
        pings: p.pings || 0,
        shouts: p.shouts || 0,
        score,
      };
    });

    // Default sort by score descending
    playersList.sort((a, b) => b.score - a.score || b.uptimeMs - a.uptimeMs);
    playersList.forEach((p, idx) => {
      p.rank = idx + 1;
    });

    // Determine Hall of Fame / Podium champions
    const topKiller = playersList.slice().sort((a, b) => b.kills - a.kills)[0] || null;
    const topSurvivor = playersList.slice().sort((a, b) => b.uptimeMs - a.uptimeMs)[0] || null;
    const topBuilder = playersList.slice().sort((a, b) => b.builds - a.builds)[0] || null;
    const topMiner = playersList.slice().sort((a, b) => b.harvests - a.harvests)[0] || null;
    const mostFallen = playersList.slice().sort((a, b) => b.deaths - a.deaths)[0] || null;

    return {
      updatedAt: new Date().toISOString(),
      totalPlayers: playersList.length,
      onlinePlayers: playersList.filter((p) => p.status === 'online').length,
      podium: {
        topKiller: topKiller && topKiller.kills > 0 ? { name: topKiller.name, count: topKiller.kills } : null,
        topSurvivor: topSurvivor && topSurvivor.uptimeMs > 0 ? { name: topSurvivor.name, count: topSurvivor.uptimeFormatted } : null,
        topBuilder: topBuilder && topBuilder.builds > 0 ? { name: topBuilder.name, count: topBuilder.builds } : null,
        topMiner: topMiner && topMiner.harvests > 0 ? { name: topMiner.name, count: topMiner.harvests } : null,
        mostFallen: mostFallen && mostFallen.deaths > 0 ? { name: mostFallen.name, count: mostFallen.deaths } : null,
      },
      players: playersList,
    };
  }

  // Get deep custom stats for a specific player (Public)
  getPlayerStats(name) {
    if (!name || !isValidPlayer(name)) return null;
    const cleanName = cleanPlayerName(name);
    if (!isValidPlayer(cleanName)) return null;
    const p = this.players[cleanName];
    if (!p) return null;

    this.ensurePlayerStats(p);
    const now = Date.now();
    let uptimeMs = p.totalUptimeMs || 0;
    const isOnline = (this.currentlyOnline && this.currentlyOnline.has(cleanName));
    if (isOnline && p.sessionStartTime) {
      const liveSession = Math.max(0, now - p.sessionStartTime);
      uptimeMs += Math.min(liveSession, 14 * 3600 * 1000);
    }
    if (p.firstSeen && p.firstSeen <= now) {
      uptimeMs = Math.min(uptimeMs, Math.max(0, now - p.firstSeen));
    }

    const totalMinutes = Math.floor(uptimeMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const uptimeFormatted = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    const kills = p.kills || 0;
    const deaths = p.deaths || 0;
    const kdRatio = deaths > 0 ? (kills / deaths).toFixed(1) : kills.toFixed(0);

    const lowerName = cleanName.toLowerCase();
    const recentEvents = this.events
      .filter((e) => e.player && e.player.toLowerCase() === lowerName)
      .slice(0, 25);

    return {
      name: p.name,
      status: isOnline ? 'online' : 'offline',
      uptimeMs,
      uptimeFormatted,
      sessionCount: p.sessionCount || 1,
      firstSeen: p.firstSeen || now,
      lastSeen: p.lastSeen || now,
      kills,
      deaths,
      kdRatio,
      lastDeathCause: p.lastDeathCause || null,
      lastDeathLocation: p.lastDeathLocation || null,
      lastLocation: p.lastLocation || null,
      builds: p.builds || 0,
      harvests: p.harvests || 0,
      pickups: p.pickups || 0,
      pings: p.pings || 0,
      shouts: p.shouts || 0,
      killsBreakdown: p.killsBreakdown || {},
      buildsBreakdown: p.buildsBreakdown || {},
      harvestsBreakdown: p.harvestsBreakdown || {},
      recentEvents,
    };
  }
}

const trackerInstance = new ActivityTracker();
module.exports = trackerInstance;
