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

  load() {
    try {
      if (fs.existsSync(STORAGE_FILE)) {
        const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
        const data = JSON.parse(raw);
        this.events = Array.isArray(data.events) ? data.events : [];
        this.players = typeof data.players === 'object' && data.players !== null ? data.players : {};

        // Scrub any corrupted / dummy players from previous parser versions
        for (const key of Object.keys(this.players)) {
          if (
            key.startsWith('playfab/') ||
            key.startsWith('steam/') ||
            key.startsWith('Client (') ||
            key === 'Connected Viking' ||
            key === '0:0' ||
            key === 'System' ||
            key === 'World' ||
            key === 'Security Alert' ||
            key === 'Security System'
          ) {
            delete this.players[key];
          }
        }

        // Scrub duplicate dummy leave events from previous parser
        this.events = this.events.filter(
          (e) => e.player !== 'Connected Viking' && !(e.player && e.player.startsWith('playfab/'))
        );

        console.log(`[activity] Loaded ${this.events.length} historical events and ${Object.keys(this.players).length} players.`);
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
    const cleanName = name.trim();

    // Prevent internal server tags, socket strings, or dummy names from creating player records
    if (
      cleanName.startsWith('playfab/') ||
      cleanName.startsWith('steam/') ||
      cleanName.startsWith('Client (') ||
      cleanName === 'Connected Viking' ||
      cleanName === 'System' ||
      cleanName === 'World' ||
      cleanName === 'Security Alert' ||
      cleanName === 'Security System' ||
      cleanName.length < 2
    ) {
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
      };
    } else {
      const p = this.players[cleanName];
      if (ip && ip !== 'Direct Connect') p.ip = ip;
      if (platformId && platformId !== 'Unknown') p.platformId = platformId;
      p.status = online ? 'online' : p.status;
      p.lastSeen = Math.max(p.lastSeen || 0, timestamp);
      if (online) p.sessionCount = (p.sessionCount || 0) + 1;
    }

    this.save();
  }

  setPlayerStatus(name, online, timestamp = Date.now()) {
    if (!name) return;
    const cleanName = name.trim();
    if (online) {
      this.currentlyOnline.add(cleanName);
    } else {
      this.currentlyOnline.delete(cleanName);
    }

    if (this.players[cleanName]) {
      this.players[cleanName].status = online ? 'online' : 'offline';
      this.players[cleanName].lastSeen = Math.max(this.players[cleanName].lastSeen || 0, timestamp);
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
    raw = '',
    timestamp = Date.now(),
  }) {
    // Enforce 14-day limit: don't record if already expired
    if (timestamp < Date.now() - RETENTION_MS) return null;

    // Use player's registered IP if not supplied
    if (!ip && player && this.players[player]) {
      ip = this.players[player].ip;
    }
    if (!ip && this.lastObservedIp) {
      ip = this.lastObservedIp;
    }

    // Deduplicate identical events within 2 seconds
    const recentDup = this.events.find(
      (e) =>
        e.player === player &&
        e.title === title &&
        Math.abs(e.timestamp - timestamp) < 2000
    );
    if (recentDup) return recentDup;

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

  // Parse a timestamp from docker log lines (ISO or "MM/DD/YYYY HH:MM:SS")
  parseTimestamp(line) {
    // 1. Docker ISO timestamp: 2026-10-12T15:47:28.481511113Z
    const isoMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    if (isoMatch) {
      const ms = Date.parse(isoMatch[1] + 'Z');
      if (!isNaN(ms)) return ms;
    }
    // 2. Valheim in-game format: 10/12/2026 15:47:28:
    const valheimMatch = line.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (valheimMatch) {
      const [_, m, d, y, h, min, s] = valheimMatch;
      const ms = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s)).getTime();
      if (!isNaN(ms)) return ms;
    }
    return Date.now();
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

      // Case A: Death (0:0)
      if (peerId === '0' && zdoid === '0') {
        this.setPlayerStatus(name, true, timestamp);
        return this.recordEvent({
          player: name,
          type: 'death',
          severity: 'warn',
          title: 'Viking Fallen in Battle',
          details: 'Character perished in battle (ZDOID reset to 0:0). Respawn pending.',
          raw: line,
          timestamp,
        });
      }

      // Case B: Character Spawn or Respawn
      if (peerId && peerId !== '0') {
        this.peerToName.set(peerId, name);
      }

      const isAlreadyOnline = this.currentlyOnline.has(name);
      this.currentlyOnline.add(name);
      this.registerPlayer(name, { online: true, timestamp });

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
    const slainMatch = line.match(/(?:Player\s+)?([A-Za-z0-9_]+)\s+(?:was killed by|died to|was slain by|fell victim to)\s+(.+)/i);
    if (slainMatch) {
      const name = slainMatch[1].trim();
      const killer = slainMatch[2].trim();
      this.registerPlayer(name, { online: true, timestamp });

      return this.recordEvent({
        player: name,
        type: 'death',
        severity: 'warn',
        title: 'Killed by Creature / Trap',
        details: `Slain by ${killer}.`,
        raw: line,
        timestamp,
      });
    }

    // 5. Disconnect via abandoned non-persistent ZDO (maps owner PeerID directly to character)
    const abandonedZdoMatch = line.match(/Destroying abandoned non persistent zdo\s+[-0-9:]+\s+owner\s+([-0-9]+)/i);
    if (abandonedZdoMatch) {
      const ownerPeerId = abandonedZdoMatch[1].trim();
      const playerName = this.peerToName.get(ownerPeerId);

      if (playerName && this.currentlyOnline.has(playerName)) {
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
      return null;
    }

    // Authoritative "Player connection lost server ... now 0 player(s)"
    const connLostMatch = line.match(/Player connection lost server .* now\s+(\d+)\s+player\(s\)/i);
    if (connLostMatch) {
      const remainingCount = parseInt(connLostMatch[1], 10);
      if (remainingCount === 0) {
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

    // 8. Modded/Server In-Game Action: Mining / Harvesting Resources
    const mineMatch = line.match(/(?:Player\s+)?([A-Za-z0-9_]+)\s+(?:mined|harvested|chopped|collected|gathered)\s+(.+)/i);
    if (mineMatch) {
      const name = mineMatch[1].trim();
      const resource = mineMatch[2].trim();
      this.registerPlayer(name, { online: true, timestamp });

      return this.recordEvent({
        player: name,
        type: 'action',
        severity: 'info',
        title: 'Resource Harvested',
        details: `Harvested/Mined ${resource}.`,
        raw: line,
        timestamp,
      });
    }

    // 9. Modded/Server In-Game Action: Monster Kills
    const killMatch = line.match(/(?:Player\s+)?([A-Za-z0-9_]+)\s+(?:killed|slayed|slew|defeated|destroyed)\s+(.+)/i);
    if (killMatch) {
      const name = killMatch[1].trim();
      const target = killMatch[2].trim();
      this.registerPlayer(name, { online: true, timestamp });

      return this.recordEvent({
        player: name,
        type: 'action',
        severity: 'info',
        title: 'Creature Slayed',
        details: `Defeated ${target} in combat.`,
        raw: line,
        timestamp,
      });
    }

    // 10. World Chat / Shout: "<Player> message" or "Player shouts: message"
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

    // 11. Handshake detection (capture client IP without creating dummy player)
    const handshakeMatch = line.match(/Got handshake from client\s+([A-Za-z0-9_/-]+)/i);
    if (handshakeMatch) {
      this.refreshClientSockets().catch(() => {});
      return null; // Don't create dummy player card for playfab/... or steam/...
    }

    // 12. Banned or Unauthorized access attempts (SUSPICIOUS)
    if (/blocked players|banned player|not in whitelist/i.test(line)) {
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
  ingestModMessage({ rawMessage, author, title, raw }) {
    if (!rawMessage) return null;
    const timestamp = Date.now();
    const text = rawMessage.trim();

    // 1. Player Joined (e.g. "Kalpa has arrived!" or "Kalpa joined the game")
    const joinMatch = text.match(/^(.+?)\s+(?:has arrived|has joined|joined the (?:server|game)|connected)/i);
    if (joinMatch) {
      const player = joinMatch[1].trim();
      this.currentlyOnline.add(player);
      this.registerPlayer(player, { online: true, timestamp });
      return this.recordEvent({
        player,
        type: 'join',
        severity: 'info',
        title: 'Viking Joined Realm',
        details: text,
        raw,
        timestamp,
      });
    }

    // 2. Player Left (e.g. "Kalpa has left." or "Kalpa left the game" or "Kalpa disconnected")
    const leaveMatch = text.match(/^(.+?)\s+(?:has left|left the (?:server|game)|disconnected)/i);
    if (leaveMatch) {
      const player = leaveMatch[1].trim();
      this.currentlyOnline.delete(player);
      this.setPlayerStatus(player, false, timestamp);
      return this.recordEvent({
        player,
        type: 'leave',
        severity: 'info',
        title: 'Viking Departed Realm',
        details: text,
        raw,
        timestamp,
      });
    }

    // 3. Player Death (e.g. "Kalpa died." or "Kalpa was killed by Troll")
    const deathMatch = text.match(/^(.+?)\s+(?:died|was killed by|perished|succumbed|fell victim to)\s*(.*)/i);
    if (deathMatch) {
      const player = deathMatch[1].trim();
      const cause = deathMatch[2]?.trim();
      this.registerPlayer(player, { online: true, timestamp });
      return this.recordEvent({
        player,
        type: 'death',
        severity: 'warn',
        title: 'Viking Fallen in Battle',
        details: cause ? `Slain by ${cause}` : text,
        raw,
        timestamp,
      });
    }

    // 4. Shout / Chat (e.g. "Kalpa: hello everyone" or "Kalpa shouts: help me")
    const chatMatch = text.match(/^(.+?)\s*(?:shouts|says|whispers)?:?\s*[:"]\s*(.+)/i);
    if (chatMatch) {
      const player = chatMatch[1].trim();
      const chat = chatMatch[2].trim();
      if (player.toLowerCase() !== 'server' && player.toLowerCase() !== 'valheim') {
        this.registerPlayer(player, { online: true, timestamp });
        return this.recordEvent({
          player,
          type: 'action',
          severity: 'info',
          title: 'World Shout / Chat',
          details: `"${chat.replace(/^"|"$/g, '')}"`,
          raw,
          timestamp,
        });
      }
    }

    // 5. Map Ping (e.g. "Kalpa pinged the map")
    const pingMatch = text.match(/^(.+?)\s+pinged the map/i);
    if (pingMatch) {
      const player = pingMatch[1].trim();
      this.registerPlayer(player, { online: true, timestamp });
      return this.recordEvent({
        player,
        type: 'action',
        severity: 'info',
        title: 'Map Ping',
        details: `${player} pinged coordinates on the world map.`,
        raw,
        timestamp,
      });
    }

    // 6. World Event / Raid (e.g. "The forest is moving..." or "A cold wind blows from the mountains")
    if (/forest is moving|foul smell|cold wind|ground is shaking|army of|skeleton surprise|hunt/i.test(text)) {
      return this.recordEvent({
        player: 'World',
        type: 'action',
        severity: 'warn',
        title: 'Raid Event',
        details: text,
        raw,
        timestamp,
      });
    }

    // 7. General mod action
    return this.recordEvent({
      player: author && author !== 'Valheim' ? author : 'Mod',
      type: 'action',
      severity: 'info',
      title: title || 'Server Event',
      details: text,
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
    for (const line of lines) {
      const evt = this.processLogLine(line);
      if (evt) count++;
    }
    console.log(`[activity] Backfill complete. Captured ${count} events.`);
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
}

const trackerInstance = new ActivityTracker();
module.exports = trackerInstance;
