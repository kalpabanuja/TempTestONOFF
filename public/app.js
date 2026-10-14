/* ═══════════════════════════════════════════════════════════════
   VALHEIM ADMIN – Frontend Logic
   ═══════════════════════════════════════════════════════════════ */

let authToken = null;
let currentUserRole = 'admin';
let currentUsername = 'admin';
let logEventSource = null;
let logLines = [];
let logPaused = false;
let logLineCount = 0;
let statusPollInterval = null;

// ─── Particle System ─────────────────────────────────────────────────────────
(function initParticles() {
  const canvas = document.getElementById('particleCanvas');
  const ctx = canvas.getContext('2d');
  let particles = [];

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  class Particle {
    constructor() { this.reset(); }
    reset() {
      this.x = Math.random() * canvas.width;
      this.y = Math.random() * canvas.height;
      this.size = Math.random() * 1.5 + 0.3;
      this.speedY = -(Math.random() * 0.4 + 0.1);
      this.speedX = (Math.random() - 0.5) * 0.2;
      this.opacity = Math.random() * 0.4 + 0.1;
      this.life = 1;
      this.decay = Math.random() * 0.003 + 0.001;
      // ember gold or dim white
      this.color = Math.random() > 0.6
        ? `rgba(200, 131, 42, ${this.opacity})`
        : `rgba(240, 220, 180, ${this.opacity * 0.4})`;
    }
    update() {
      this.y += this.speedY;
      this.x += this.speedX;
      this.life -= this.decay;
      if (this.life <= 0 || this.y < 0) this.reset();
    }
    draw() {
      ctx.save();
      ctx.globalAlpha = this.life * this.opacity;
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  for (let i = 0; i < 80; i++) particles.push(new Particle());

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => { p.update(); p.draw(); });
    requestAnimationFrame(animate);
  }
  animate();
})();

// ─── View helpers ─────────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(name + 'View').classList.add('active');
}

// ─── Session persistence ──────────────────────────────────────────────────────
function saveSession(token, role = 'admin', username = 'admin') {
  authToken = token;
  currentUserRole = role || 'user';
  currentUsername = username || 'admin';
  sessionStorage.setItem('vh_token', token);
  sessionStorage.setItem('vh_role', currentUserRole);
  sessionStorage.setItem('vh_user', currentUsername);
}

function loadSession() {
  const token = sessionStorage.getItem('vh_token');
  if (token) {
    authToken = token;
    currentUserRole = sessionStorage.getItem('vh_role') || 'user';
    currentUsername = sessionStorage.getItem('vh_user') || 'admin';
    return true;
  }
  return false;
}

function clearSession() {
  authToken = null;
  currentUserRole = 'user';
  currentUsername = '';
  sessionStorage.removeItem('vh_token');
  sessionStorage.removeItem('vh_role');
  sessionStorage.removeItem('vh_user');
}

// ─── API helper ───────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    logout();
    throw new Error('Session expired');
  }
  return res;
}

// ─── Login ────────────────────────────────────────────────────────────────────
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  const spinner = btn.querySelector('.btn-spinner');
  const btnText = btn.querySelector('.btn-text');
  const errorEl = document.getElementById('loginError');
  const errorText = document.getElementById('loginErrorText');

  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;

  btn.disabled = true;
  spinner.classList.remove('hidden');
  btnText.textContent = 'VERIFYING...';
  errorEl.classList.add('hidden');

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (res.ok) {
      saveSession(data.token, data.role, data.username);
      initDashboard();
    } else {
      errorText.textContent = data.error || 'Invalid credentials';
      errorEl.classList.remove('hidden');
    }
  } catch (err) {
    errorText.textContent = 'Cannot reach server. Is it running?';
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    spinner.classList.add('hidden');
    btnText.textContent = 'ENTER THE REALM';
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
function logout() {
  clearSession();
  stopLogStream();
  stopEventStream();
  clearInterval(statusPollInterval);
  clearInterval(infoInterval);
  showView('login');
  document.getElementById('loginForm').reset();
  document.getElementById('loginError').classList.add('hidden');
}

document.getElementById('logoutBtn').addEventListener('click', logout);

// ─── Dashboard init ───────────────────────────────────────────────────────────
function initDashboard() {
  showView('dashboard');
  applyRolePermissions();

  // Reflect actual server host IP in address stat if accessing remotely
  if (window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    const addrEl = document.getElementById('infoAddress');
    if (addrEl) addrEl.textContent = `${window.location.hostname}:2456`;
  }

  fetchStatus();
  fetchServerInfo();    // Immediate fetch of join code and player stats
  statusPollInterval = setInterval(fetchStatus, 10000);
  startEventStream();   // live push for player count + join code
  startLogStream();     // live log tail
}

// ─── Status ───────────────────────────────────────────────────────────────────
async function fetchStatus() {
  const dot   = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  try {
    const res  = await apiFetch('/api/status');
    const data = await res.json();
    const s    = data.status || 'unknown';

    dot.className = 'status-dot';
    if (s === 'running') {
      dot.classList.add('running');
      label.textContent = '● Running';
    } else if (s === 'exited' || s === 'stopped') {
      dot.classList.add('stopped');
      label.textContent = '● Stopped';
    } else {
      dot.classList.add('loading');
      label.textContent = `● ${s.charAt(0).toUpperCase() + s.slice(1)}`;
    }
  } catch (_) {
    dot.className = 'status-dot stopped';
    label.textContent = '● Unreachable';
  }
}

// ─── Server Info (players + join code) ───────────────────────────────────────
let infoInterval = null;
let infoEventSource = null;

// Shared render function — called by both the SSE event stream and manual fetch
function updateInfoBar(data) {
  // Player count
  const playerEl = document.getElementById('infoPlayerCount');
  const count = typeof data.playerCount === 'number' ? data.playerCount : 0;
  if (count === 0) {
    playerEl.textContent = '0 (empty)';
  } else if (Array.isArray(data.players) && data.players.length > 0) {
    playerEl.textContent = `${count} online (${data.players.join(', ')})`;
  } else {
    playerEl.textContent = `${count} online`;
  }
  playerEl.classList.toggle('has-players', count > 0);

  // Join code
  const joinEl = document.getElementById('infoJoinCode');
  joinEl.textContent = data.joinCode || 'Not found in logs';
  joinEl.dataset.code = data.joinCode || '';

  // Last refreshed timestamp
  const now = new Date();
  document.getElementById('infoLastRefresh').textContent =
    now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Brief flash on player join/leave events
  if (data.lastEvent === 'player_join' || data.lastEvent === 'player_leave') {
    const panel = document.querySelector('.info-panel');
    panel.classList.add('info-flash');
    setTimeout(() => panel.classList.remove('info-flash'), 600);
  }
}

// Live SSE connection — backend pushes instantly when events happen
function startEventStream() {
  stopEventStream();
  infoEventSource = new EventSource(`/api/events?token=${encodeURIComponent(authToken)}`);

  // Instant update whenever the backend detects a player/server event
  infoEventSource.addEventListener('info', (e) => {
    try { updateInfoBar(JSON.parse(e.data)); } catch (_) {}
  });

  // Live push for user activity & security alerts
  infoEventSource.addEventListener('activity', (e) => {
    try { onLiveActivityReceived(JSON.parse(e.data)); } catch (_) {}
  });

  infoEventSource.onerror = () => {
    // SSE disconnected — fall back to polling every 15s until reconnected
    if (!infoInterval) {
      infoInterval = setInterval(fetchServerInfo, 15000);
    }
  };

  infoEventSource.onopen = () => {
    // Reconnected — stop fallback polling
    clearInterval(infoInterval);
    infoInterval = null;
  };
}

function stopEventStream() {
  if (infoEventSource) { infoEventSource.close(); infoEventSource = null; }
  clearInterval(infoInterval);
  infoInterval = null;
}

// Manual refresh — used by the ↺ button and as fallback when SSE is down
async function fetchServerInfo() {
  try {
    const res  = await apiFetch('/api/info');
    const data = await res.json();
    updateInfoBar(data);
  } catch (_) {
    document.getElementById('infoPlayerCount').textContent = '—';
    document.getElementById('infoJoinCode').textContent = '—';
  }
}

function copyJoinCode(btnEl) {
  const joinEl = document.getElementById('infoJoinCode');
  const code = (joinEl?.dataset?.code || joinEl?.textContent || '').trim();
  const btn = btnEl || document.getElementById('btnCopyJoin');

  if (!code || code === '—' || code.includes('Not found') || code.length < 3) {
    showToast('✘ No Join Code available yet. Make sure server is running.', true);
    return;
  }
  copyToClipboard(code, btn);
}

function copyAddress(btnEl) {
  const addrEl = document.getElementById('infoAddress');
  let addr = (addrEl?.textContent || '').trim();
  if (!addr || addr === '—') {
    addr = `${window.location.hostname || '172.105.121.226'}:2456`;
  }
  const btn = btnEl || document.getElementById('btnCopyAddress');
  copyToClipboard(addr, btn);
}

function copyToClipboard(text, btn) {
  if (!text) return;

  function doFallback() {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, 99999);
      const successful = document.execCommand('copy');
      document.body.removeChild(ta);
      if (successful) {
        flashCopied(btn);
        showToast(`✔ Copied: ${text}`);
      } else {
        window.prompt('Copy to clipboard: Ctrl+C, Enter', text);
        flashCopied(btn);
      }
    } catch (_) {
      window.prompt('Copy to clipboard: Ctrl+C, Enter', text);
      flashCopied(btn);
    }
  }

  // Modern clipboard API is ONLY available in secure contexts (HTTPS or localhost)
  // On plain HTTP (e.g. http://<server-ip>:3000), navigator.clipboard is undefined
  if (window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(() => {
      flashCopied(btn);
      showToast(`✔ Copied: ${text}`);
    }).catch(() => {
      doFallback();
    });
  } else {
    doFallback();
  }
}

function flashCopied(btn) {
  if (!btn) return;
  const orig = btn.textContent;
  btn.classList.add('copied');
  btn.textContent = '✔';
  setTimeout(() => { btn.classList.remove('copied'); btn.textContent = orig; }, 1500);
}

// ─── Server Actions ───────────────────────────────────────────────────────────
async function serverAction(action) {
  const btns = document.querySelectorAll('.ctrl-btn');
  btns.forEach(b => b.disabled = true);

  showToast(`Sending ${action} command...`, false);

  try {
    const res  = await apiFetch(`/api/server/${action}`, { method: 'POST' });
    const data = await res.json();

    if (res.ok) {
      showToast(`✔ ${data.message}`, false);
      // Update status and server info after a small delay
      setTimeout(fetchStatus, 2000);
      setTimeout(fetchStatus, 5000);
      setTimeout(fetchServerInfo, 6000); // re-fetch info after server comes back up
    } else {
      showToast(`✘ Error: ${data.error}`, true);
    }
  } catch (err) {
    showToast('✘ Request failed – check server connection', true);
  } finally {
    btns.forEach(b => b.disabled = false);
  }
}

function showToast(msg, isError = false) {
  const toast = document.getElementById('actionToast');
  const text  = document.getElementById('actionToastText');
  toast.textContent = msg;
  toast.classList.remove('hidden', 'error');
  if (isError) toast.classList.add('error');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), 5000);
}

// ─── Log stream (SSE) ─────────────────────────────────────────────────────────
function startLogStream() {
  stopLogStream();

  const container   = document.getElementById('logContainer');
  const streamStatus = document.getElementById('logStreamStatus');

  container.innerHTML = `
    <div class="log-connecting">
      <div class="spinner"></div>
      <span>Connecting to log stream...</span>
    </div>`;

  // SSE doesn't support custom headers, so we pass token as query param
  logEventSource = new EventSource(`/api/logs?token=${encodeURIComponent(authToken)}`);

  logLineCount = 0;
  logLines = [];

  logEventSource.onopen = () => {
    container.innerHTML = '';
    streamStatus.textContent = '● Live';
    streamStatus.className = 'log-stream-status connected';
  };

  logEventSource.onmessage = (event) => {
    if (logPaused) return;

    let line;
    try { line = JSON.parse(event.data); }
    catch (_) { line = event.data; }

    logLines.push(line);
    logLineCount++;
    document.getElementById('logCount').textContent = `${logLineCount} lines`;

    const el = document.createElement('span');
    el.className = 'log-line ' + classifyLog(line);
    el.textContent = line;
    container.appendChild(el);

    // Auto-scroll
    container.scrollTop = container.scrollHeight;

    // Keep memory bounded (max 2000 lines in DOM)
    if (container.children.length > 2000) {
      container.removeChild(container.firstChild);
    }
  };

  logEventSource.onerror = () => {
    streamStatus.textContent = '● Disconnected';
    streamStatus.className = 'log-stream-status error';
  };
}

function stopLogStream() {
  if (logEventSource) { logEventSource.close(); logEventSource = null; }
}

function classifyLog(line) {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes('exception') || l.includes('fatal') || l.includes('failed')) return 'error';
  if (l.includes('warn') || l.includes('destroyed') || l.includes('abandoned')) return 'warn';
  if (
    l.includes('info') || l.includes('starting') || l.includes('loaded') ||
    l.includes('got character') || l.includes('player joined') || l.includes('player connection') ||
    l.includes('dungeon') || l.includes('world saved') || l.includes('connections') ||
    l.includes('[bepinex]') || l.includes('[discordconnector]') || l.includes('[info   :') ||
    l.includes('valheim version') || l.includes('game server')
  ) return 'info';
  return '';
}

function toggleLogs() {
  logPaused = !logPaused;
  const btn = document.getElementById('btnToggleLogs');
  const streamStatus = document.getElementById('logStreamStatus');

  if (logPaused) {
    btn.textContent = '▶ Resume';
    streamStatus.textContent = '● Paused';
    streamStatus.className = 'log-stream-status paused';
  } else {
    btn.textContent = '⏸ Pause';
    streamStatus.textContent = '● Live';
    streamStatus.className = 'log-stream-status connected';
  }
}

function clearLogs() {
  document.getElementById('logContainer').innerHTML = '';
  logLineCount = 0;
  logLines = [];
  document.getElementById('logCount').textContent = '0 lines';
}

function downloadLogs() {
  const content = logLines.join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `valheim-logs-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── World Map & Tabs ────────────────────────────────────────────────────────
let currentActiveTab = 'dashboard';
let currentWorldSeed = '';
let currentWorldName = '';
let mapLoaded = false;

// ─── User Activity & Player Registry ───────────────────────────────────────
let activityFilterTimeout = null;
let currentActivityEvents = [];
let knownPlayersList = [];

// ─── Role Permissions & Tab Guard ──────────────────────────────────────────
function applyRolePermissions() {
  const isAdmin = currentUserRole === 'admin';

  // 1. Navbar Role Badge
  const roleBadge = document.getElementById('userRoleBadge');
  const roleIcon = document.getElementById('userRoleIcon');
  const roleName = document.getElementById('userRoleName');
  if (roleBadge) {
    roleBadge.className = `user-role-badge ${isAdmin ? 'role-admin' : 'role-user'}`;
    if (roleIcon) roleIcon.textContent = isAdmin ? '👑' : '🛡';
    if (roleName) roleName.textContent = isAdmin ? `Admin (${currentUsername})` : `User (${currentUsername})`;
  }

  // 2. Leaderboard Tab: Visible to ALL roles
  const tabLeaderboard = document.getElementById('tabBtnLeaderboard');
  if (tabLeaderboard) {
    tabLeaderboard.style.display = 'inline-flex';
  }

  // 3. User Activity Nav Tab: Only admin can see user activities
  const tabActivity = document.getElementById('tabBtnActivity');
  if (tabActivity) {
    tabActivity.style.display = isAdmin ? 'inline-flex' : 'none';
  }

  // If user is currently on activity tab and is not admin, force back to dashboard
  if (!isAdmin && currentActiveTab === 'activity') {
    switchTab('dashboard');
  }

  // 3. Server Controls: Enabled for both Admin and User roles
  const notice = document.getElementById('userViewOnlyNotice');
  if (notice) {
    notice.classList.add('hidden');
  }

  const ctrlBtns = document.querySelectorAll('.ctrl-btn');
  ctrlBtns.forEach((btn) => {
    btn.disabled = false;
    btn.title = '';
    btn.classList.remove('disabled-user');
  });
}

function switchTab(tab) {
  // Guard: Only admin can view user activities
  if (tab === 'activity' && currentUserRole !== 'admin') {
    showToast('✘ Access Denied: Only administrators can view User Activities.', true);
    tab = 'dashboard';
  }

  currentActiveTab = tab;

  // Toggle tab buttons
  const btnDash = document.getElementById('tabBtnDashboard');
  const btnLead = document.getElementById('tabBtnLeaderboard');
  const btnAct  = document.getElementById('tabBtnActivity');
  const btnMap  = document.getElementById('tabBtnMap');
  if (btnDash) btnDash.classList.toggle('active', tab === 'dashboard');
  if (btnLead) btnLead.classList.toggle('active', tab === 'leaderboard');
  if (btnAct)  btnAct.classList.toggle('active', tab === 'activity');
  if (btnMap)  btnMap.classList.toggle('active', tab === 'map');

  // Toggle tab panes
  const paneDash = document.getElementById('tabContentDashboard');
  const paneLead = document.getElementById('tabContentLeaderboard');
  const paneAct  = document.getElementById('tabContentActivity');
  const paneMap  = document.getElementById('tabContentMap');
  if (paneDash) paneDash.classList.toggle('active', tab === 'dashboard');
  if (paneLead) paneLead.classList.toggle('active', tab === 'leaderboard');
  if (paneAct)  paneAct.classList.toggle('active', tab === 'activity');
  if (paneMap)  paneMap.classList.toggle('active', tab === 'map');

  if (tab === 'leaderboard') {
    loadLeaderboard();
  } else if (tab === 'activity') {
    loadPlayers();
    loadActivityLogs();
  } else if (tab === 'map' && !mapLoaded) {
    fetchWorldInfo();
  }
}

// Format relative time (e.g. "2 mins ago", "Yesterday")
function formatRelativeTime(timestamp) {
  if (!timestamp) return '—';
  const diff = Date.now() - Number(timestamp);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

// ─── Player Directory ───────────────────────────────────────────────────────
async function loadPlayers() {
  const container = document.getElementById('playersDirectoryList');
  if (!container) return;

  try {
    const res = await apiFetch('/api/players');
    const data = await res.json();
    knownPlayersList = Array.isArray(data.players) ? data.players : [];

    // Populate user filter dropdown
    const userSelect = document.getElementById('filterUser');
    if (userSelect) {
      const currentVal = userSelect.value;
      userSelect.innerHTML = '<option value="all">All Vikings</option>';
      knownPlayersList.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name + (p.status === 'online' ? ' (Online)' : '');
        userSelect.appendChild(opt);
      });
      userSelect.value = currentVal || 'all';
    }

    if (knownPlayersList.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🛡</span>
          <p class="empty-title">No Vikings Recorded Yet</p>
          <span class="empty-sub">Players will automatically register here with their IP addresses as soon as they connect to the realm.</span>
        </div>
      `;
      return;
    }

    container.innerHTML = knownPlayersList.map((player) => {
      const isOnline = player.status === 'online';
      const cleanIp = player.ip || 'Direct / Relay';

      return `
        <div class="player-card ${isOnline ? 'online' : 'offline'}">
          <div class="player-card-header">
            <div class="player-avatar">${player.name.charAt(0).toUpperCase()}</div>
            <div class="player-title-wrap">
              <span class="player-card-name" title="${escapeHtml(player.name)}">${escapeHtml(player.name)}</span>
              <div class="player-status-tag ${isOnline ? 'online' : 'offline'}">
                <span class="status-dot-sm ${isOnline ? 'running' : 'stopped'}"></span>
                <span>${isOnline ? 'Active Online' : `Seen ${formatRelativeTime(player.lastSeen)}`}</span>
              </div>
            </div>
          </div>

          <div class="player-card-details">
            <div class="player-meta-row">
              <span class="meta-label">IP ADDRESS:</span>
              <div class="meta-val-ip-wrap">
                <span class="meta-val mono ip-text" title="${escapeHtml(cleanIp)}">${escapeHtml(cleanIp)}</span>
                <button class="btn-copy-sm" title="Copy IP" onclick="copyText('${escapeHtml(cleanIp)}')">⧉</button>
              </div>
            </div>

            <div class="player-meta-row">
              <span class="meta-label">NETWORK ID:</span>
              <span class="meta-val mono" title="${escapeHtml(player.platformId || 'N/A')}">${escapeHtml(player.platformId || 'Direct Peer')}</span>
            </div>

            <div class="player-meta-row">
              <span class="meta-label">FIRST JOINED:</span>
              <span class="meta-val">${formatRelativeTime(player.firstSeen)}</span>
            </div>
          </div>

          <div class="player-card-actions">
            <button class="btn-filter-user" onclick="filterByPlayer('${escapeHtml(player.name)}')">
              🔍 Filter Audit Logs
            </button>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    container.innerHTML = `
      <div class="empty-state error">
        <span class="empty-icon">⚠</span>
        <p class="empty-title">Failed to Query Player Registry</p>
        <span class="empty-sub">${escapeHtml(err.message)}</span>
      </div>
    `;
  }
}

// ─── Activity Log Feed ──────────────────────────────────────────────────────
async function loadActivityLogs() {
  const feed = document.getElementById('activityLogFeed');
  if (!feed) return;

  const search = document.getElementById('activitySearchInput')?.value || '';
  const user = document.getElementById('filterUser')?.value || 'all';
  const category = document.getElementById('filterCategory')?.value || 'all';
  const severity = document.getElementById('filterSeverity')?.value || 'all';
  const timeRange = document.getElementById('filterTimeRange')?.value || '14d';

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (user !== 'all') params.set('user', user);
  if (category !== 'all') params.set('type', category);
  if (severity !== 'all') params.set('severity', severity);
  if (timeRange !== '14d') params.set('timeRange', timeRange);

  try {
    const res = await apiFetch(`/api/activity?${params.toString()}`);
    const data = await res.json();
    currentActivityEvents = Array.isArray(data.events) ? data.events : [];
    const stats = data.stats || {};

    // Update stats cards
    const statKnown = document.getElementById('statKnownPlayers');
    const statOnline = document.getElementById('statOnlinePlayers');
    const statTotal = document.getElementById('statTotalEvents');
    const statSuspicious = document.getElementById('statSuspiciousCount');
    const navBadge = document.getElementById('suspiciousNavBadge');

    if (statKnown) statKnown.textContent = stats.totalPlayers ?? 0;
    if (statOnline) statOnline.textContent = stats.onlinePlayers ?? 0;
    if (statTotal) statTotal.textContent = stats.totalEvents ?? 0;
    if (statSuspicious) statSuspicious.textContent = stats.suspiciousEvents ?? 0;

    if (navBadge) {
      const sCount = stats.suspiciousEvents || 0;
      navBadge.textContent = sCount > 99 ? '99+' : sCount;
      navBadge.classList.toggle('hidden', sCount === 0);
    }

    renderActivityFeed(currentActivityEvents);

  } catch (err) {
    feed.innerHTML = `
      <div class="empty-state error">
        <span class="empty-icon">⚠</span>
        <p class="empty-title">Error Loading Activity Log</p>
        <span class="empty-sub">${escapeHtml(err.message)}</span>
      </div>
    `;
  }
}

function renderActivityFeed(events) {
  const feed = document.getElementById('activityLogFeed');
  const countEl = document.getElementById('activityLogCount');
  if (!feed) return;

  if (countEl) countEl.textContent = `Showing ${events.length} event${events.length === 1 ? '' : 's'}`;

  if (!events || events.length === 0) {
    feed.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">📜</span>
        <p class="empty-title">No Matching Activity Found</p>
        <span class="empty-sub">Try broadening your search or choosing "All Categories".</span>
      </div>
    `;
    return;
  }

  feed.innerHTML = events.map((e) => {
    let icon = '📜';
    let typeBadge = (e.type || 'INFO').toUpperCase();
    let severityClass = e.severity || 'info';

    if (e.type === 'join') {
      icon = '⚔';
      typeBadge = 'JOIN';
    } else if (e.type === 'leave') {
      icon = '🚪';
      typeBadge = 'LEAVE';
    } else if (e.type === 'death') {
      icon = '💀';
      typeBadge = 'DEATH';
    } else if (e.type === 'action') {
      icon = '⛏';
      typeBadge = 'ACTION';
    } else if (e.type === 'suspicious') {
      icon = '🚨';
      typeBadge = 'SUSPICIOUS';
      severityClass = 'danger';
    }

    const hasRaw = Boolean(e.raw && e.raw.trim());
    const rawId = `raw_${e.id}`;

    return `
      <div class="activity-card ${severityClass} ${e.type}">
        <div class="activity-icon-badge">${icon}</div>
        <div class="activity-content">
          <div class="activity-header-line">
            <div class="activity-tags">
              <span class="activity-badge badge-${severityClass}">${typeBadge}</span>
              <button class="activity-player-pill" onclick="filterByPlayer('${escapeHtml(e.player)}')" title="Filter by ${escapeHtml(e.player)}">
                👤 ${escapeHtml(e.player)}
              </button>
              ${e.ip ? `<span class="activity-ip-pill mono" onclick="copyText('${escapeHtml(e.ip)}')" title="Click to copy IP">🌐 ${escapeHtml(e.ip)}</span>` : ''}
            </div>
            <div class="activity-time-wrap" title="${escapeHtml(e.dateStr || '')}">
              <span class="activity-rel-time">${formatRelativeTime(e.timestamp)}</span>
              <span class="activity-exact-time mono">${escapeHtml(e.dateStr || '')}</span>
            </div>
          </div>

          <div class="activity-title-text">${escapeHtml(e.title || 'Event')}</div>
          <div class="activity-details-text">${escapeHtml(e.details || '')}</div>

          ${hasRaw ? `
            <div class="activity-raw-toggle" onclick="toggleRawSnippet('${rawId}')">
              <span>▶ Server log snippet</span>
            </div>
            <div id="${rawId}" class="activity-raw-content mono hidden">
              ${escapeHtml(e.raw)}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function toggleRawSnippet(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const isHidden = el.classList.toggle('hidden');
  const toggleBtn = el.previousElementSibling;
  if (toggleBtn) {
    toggleBtn.querySelector('span').textContent = isHidden ? '▶ Server log snippet' : '▼ Hide server log snippet';
  }
}

function debounceFilterActivity() {
  const input = document.getElementById('activitySearchInput');
  const clearBtn = document.getElementById('btnClearSearch');
  if (clearBtn) clearBtn.classList.toggle('hidden', !input.value);

  if (activityFilterTimeout) clearTimeout(activityFilterTimeout);
  activityFilterTimeout = setTimeout(() => {
    loadActivityLogs();
  }, 350);
}

function clearActivitySearch() {
  const input = document.getElementById('activitySearchInput');
  if (input) input.value = '';
  const clearBtn = document.getElementById('btnClearSearch');
  if (clearBtn) clearBtn.classList.add('hidden');
  loadActivityLogs();
}

function applyActivityFilters() {
  loadActivityLogs();
}

function filterByPlayer(playerName) {
  if (!playerName || playerName === 'System' || playerName.includes('(')) return;
  const userSelect = document.getElementById('filterUser');
  if (userSelect) {
    let found = false;
    for (let opt of userSelect.options) {
      if (opt.value.toLowerCase() === playerName.toLowerCase()) {
        opt.selected = true;
        found = true;
        break;
      }
    }
    if (!found) {
      const newOpt = document.createElement('option');
      newOpt.value = playerName;
      newOpt.textContent = playerName;
      newOpt.selected = true;
      userSelect.appendChild(newOpt);
    }
  }

  const feed = document.getElementById('activityLogFeed');
  if (feed) feed.scrollIntoView({ behavior: 'smooth', block: 'start' });

  loadActivityLogs();
  showToast(`Filtered activity for ${playerName}`);
}

function filterSuspiciousOnly() {
  const catSelect = document.getElementById('filterCategory');
  if (catSelect) catSelect.value = 'suspicious';
  loadActivityLogs();
  const feed = document.getElementById('activityLogFeed');
  if (feed) feed.scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast('Filtered to Suspicious Activity only');
}

// Live activity received via SSE
function onLiveActivityReceived(event) {
  // Only admins receive and render activity updates
  if (currentUserRole !== 'admin') return;

  const navBadge = document.getElementById('suspiciousNavBadge');
  if (navBadge && (event.type === 'suspicious' || event.severity === 'danger')) {
    navBadge.classList.remove('hidden');
    const cur = parseInt(navBadge.textContent) || 0;
    navBadge.textContent = cur + 1;
  }

  if (currentActiveTab === 'activity') {
    currentActivityEvents.unshift(event);
    renderActivityFeed(currentActivityEvents);

    if (event.type === 'join' || event.type === 'leave') {
      loadPlayers();
    }
  }
}

// Export dropdown
function toggleExportMenu() {
  const menu = document.getElementById('exportDropdownMenu');
  if (menu) menu.classList.toggle('hidden');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown-export')) {
    const menu = document.getElementById('exportDropdownMenu');
    if (menu) menu.classList.add('hidden');
  }
});

function exportLogs(format = 'json') {
  toggleExportMenu();
  const url = `/api/activity/export?format=${format}&token=${encodeURIComponent(authToken)}`;
  window.open(url, '_blank');
}

async function confirmClearActivity() {
  if (!confirm('Are you sure you want to clear the 14-day activity log history? This cannot be undone.')) {
    return;
  }
  try {
    const res = await apiFetch('/api/activity/clear', { method: 'POST' });
    if (res.ok) {
      showToast('Activity log history cleared');
      loadActivityLogs();
    } else {
      showToast('Failed to clear activity logs', true);
    }
  } catch (_) {
    showToast('Error sending clear request', true);
  }
}

function copyText(str) {
  if (!str) return;
  copyToClipboard(str, window.event ? window.event.currentTarget : null);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function fetchWorldInfo(forceReload = false) {
  const overlay = document.getElementById('mapLoadingOverlay');
  if (overlay) overlay.classList.remove('hidden');

  try {
    const res = await apiFetch('/api/world');
    const data = await res.json();

    currentWorldName = data.worldName || 'Dedicated';
    currentWorldSeed = data.seed || '';

    // Update UI elements
    const titleEl = document.getElementById('mapWorldTitle');
    if (titleEl) titleEl.textContent = `Realm: ${currentWorldName}`;
    const badgeName = document.getElementById('badgeWorldName');
    if (badgeName) badgeName.textContent = currentWorldName;
    const badgeSeed = document.getElementById('badgeActiveSeed');
    if (badgeSeed) badgeSeed.textContent = currentWorldSeed || 'None';
    const seedInput = document.getElementById('mapSeedInput');
    if (seedInput) seedInput.value = currentWorldSeed;

    loadMapInIframe(currentWorldSeed);
    mapLoaded = true;

    if (forceReload) {
      showToast(currentWorldSeed ? `Seed detected: ${currentWorldSeed}` : 'No seed file found — enter a seed manually');
    }
  } catch (err) {
    if (overlay) overlay.classList.add('hidden');
    showToast('Failed to query server world metadata');
  }
}

function loadMapInIframe(seed) {
  const frame = document.getElementById('worldMapFrame');
  const overlay = document.getElementById('mapLoadingOverlay');
  if (overlay) overlay.classList.remove('hidden');

  const url = seed
    ? `https://valheim-map.world/?seed=${encodeURIComponent(seed)}`
    : 'https://valheim-map.world/';

  if (frame) {
    frame.src = url;
    frame.onload = () => {
      if (overlay) overlay.classList.add('hidden');
    };
  }

  // Safety fallback if iframe load event is suppressed
  setTimeout(() => {
    if (overlay) overlay.classList.add('hidden');
  }, 3500);
}

async function detectServerSeed() {
  await fetchWorldInfo(true);
}

async function applyCustomSeed() {
  const input = document.getElementById('mapSeedInput');
  const newSeed = (input && input.value ? input.value : '').trim();
  if (!newSeed) {
    showToast('Please enter a valid seed string');
    return;
  }

  try {
    const res = await apiFetch('/api/world/seed', {
      method: 'POST',
      body: JSON.stringify({ seed: newSeed })
    });
    const data = await res.json();
    currentWorldSeed = data.seed;
    const badgeSeed = document.getElementById('badgeActiveSeed');
    if (badgeSeed) badgeSeed.textContent = currentWorldSeed;
    loadMapInIframe(currentWorldSeed);
    showToast(`Loaded map with seed: ${currentWorldSeed}`);
  } catch (_) {
    showToast('Error applying seed');
  }
}

function openMapExternal() {
  const input = document.getElementById('mapSeedInput');
  const seed = currentWorldSeed || (input ? input.value.trim() : '');
  const url = seed
    ? `https://valheim-map.world/?seed=${encodeURIComponent(seed)}`
    : 'https://valheim-map.world/';
  window.open(url, '_blank', 'noopener,noreferrer');
}

function copyMapLink() {
  const input = document.getElementById('mapSeedInput');
  const seed = currentWorldSeed || (input ? input.value.trim() : '');
  const url = seed
    ? `https://valheim-map.world/?seed=${encodeURIComponent(seed)}`
    : 'https://valheim-map.world/';
  copyToClipboard(url, document.getElementById('btnCopyMapLink'));
}

// ─── LEADERBOARD & WARRIOR CHRONICLES ─────────────────────────────────────────
let rawLeaderboardData = null;
let currentChroniclePlayer = null;

async function loadLeaderboard() {
  const podiumEl = document.getElementById('leaderboardPodium');
  const listEl = document.getElementById('leaderboardList');
  if (!podiumEl || !listEl) return;

  const adminActions = document.getElementById('leaderAdminActions');
  if (adminActions) {
    adminActions.style.display = authToken ? 'flex' : 'none';
  }

  try {
    const res = await apiFetch('/api/leaderboard');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    rawLeaderboardData = data;
    renderLeaderboardPodium(data.podium);
    renderLeaderboardList(data.players || []);
  } catch (err) {
    listEl.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">⚠️</span>
        <span class="empty-title">Leaderboard Unavailable</span>
        <span class="empty-sub">Unable to connect to realm registry: ${err.message || 'Server error'}.</span>
      </div>
    `;
  }
}

async function triggerLeaderboardRecalc() {
  if (!confirm('Recalculate leaderboard stats from verified events?\n\nThis will strip false deaths from routine player logouts and accurately recalculate actual logins from scratch.')) {
    return;
  }
  try {
    const res = await apiFetch('/api/leaderboard/reset', {
      method: 'POST',
      body: JSON.stringify({ wipeAll: false }),
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Leaderboard stats recalculated!', 'success');
      loadLeaderboard();
    } else {
      showToast(data.error || 'Failed to recalculate', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function triggerLeaderboardReset() {
  if (!confirm('⚠️ ARE YOU SURE?\n\nThis will completely wipe all leaderboard metrics (uptime, kills, deaths, builds, etc.) back to 0 for a brand new season.')) {
    return;
  }
  try {
    const res = await apiFetch('/api/leaderboard/reset', {
      method: 'POST',
      body: JSON.stringify({ wipeAll: true }),
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Leaderboard reset to zero!', 'success');
      loadLeaderboard();
    } else {
      showToast(data.error || 'Failed to reset', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderLeaderboardPodium(podium = {}) {
  const podiumEl = document.getElementById('leaderboardPodium');
  if (!podiumEl) return;

  const champions = [
    {
      title: 'Slayer of Beasts',
      icon: '⚔️',
      name: podium.topKiller ? podium.topKiller.name : 'Unclaimed',
      stat: podium.topKiller ? `${podium.topKiller.count} Slain` : '0 kills',
      desc: 'Most creatures defeated in combat',
      badge: 'PvE Champion',
      clickable: !!podium.topKiller
    },
    {
      title: 'Ancient Mariner',
      icon: '⏳',
      name: podium.topSurvivor ? podium.topSurvivor.name : 'Unclaimed',
      stat: podium.topSurvivor ? podium.topSurvivor.count : '0m',
      desc: 'Longest active presence in realm',
      badge: 'Realm Veteran',
      clickable: !!podium.topSurvivor
    },
    {
      title: 'Master Architect',
      icon: '🔨',
      name: podium.topBuilder ? podium.topBuilder.name : 'Unclaimed',
      stat: podium.topBuilder ? `${podium.topBuilder.count} Erected` : '0 built',
      desc: 'Most structures & defenses placed',
      badge: 'High Carpenter',
      clickable: !!podium.topBuilder
    },
    {
      title: 'Mountain Delver',
      icon: '⛏️',
      name: podium.topMiner ? podium.topMiner.name : 'Unclaimed',
      stat: podium.topMiner ? `${podium.topMiner.count} Extracted` : '0 mined',
      desc: 'Most ores & timber gathered',
      badge: 'Grand Miner',
      clickable: !!podium.topMiner
    },
    {
      title: 'Valhalla Veteran',
      icon: '💀',
      name: podium.mostFallen ? podium.mostFallen.name : 'None',
      stat: podium.mostFallen ? `${podium.mostFallen.count} Fallen` : '0 deaths',
      desc: 'Most valiant deaths in the wild',
      badge: 'Odin\'s Guest',
      clickable: !!podium.mostFallen
    }
  ];

  podiumEl.innerHTML = champions.map(c => `
    <div class="podium-card ${c.clickable ? 'clickable' : ''}" ${c.clickable ? `onclick="openPlayerModal('${escapeHtml(c.name)}')"` : ''}>
      <div class="podium-card-top">
        <span class="podium-trophy">${c.icon}</span>
        <span class="podium-badge">${c.badge}</span>
      </div>
      <div class="podium-champion-name">${escapeHtml(c.name)}</div>
      <div class="podium-champion-stat">${c.stat}</div>
      <div class="podium-champion-desc">${c.desc}</div>
    </div>
  `).join('');
}

function renderLeaderboardList(players = []) {
  const listEl = document.getElementById('leaderboardList');
  if (!listEl) return;

  if (players.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🛡</span>
        <span class="empty-title">No Vikings Recorded Yet</span>
        <span class="empty-sub">Once warriors connect and venture into the world, their deeds and statistics will appear here.</span>
      </div>
    `;
    return;
  }

  listEl.innerHTML = players.map(p => {
    let rankBadge = `#${p.rank}`;
    let rankClass = '';
    if (p.rank === 1) { rankBadge = '🥇 1'; rankClass = 'rank-gold'; }
    else if (p.rank === 2) { rankBadge = '🥈 2'; rankClass = 'rank-silver'; }
    else if (p.rank === 3) { rankBadge = '🥉 3'; rankClass = 'rank-bronze'; }

    const isOnline = p.status === 'online';

    return `
      <div class="leader-card ${rankClass}" onclick="openPlayerModal('${escapeHtml(p.name)}')">
        <div class="leader-rank-badge">${rankBadge}</div>

        <div class="leader-main-info">
          <div class="leader-name-row">
            <span class="leader-name">${escapeHtml(p.name)}</span>
            <span class="status-indicator-dot ${isOnline ? 'online' : 'offline'}" title="${isOnline ? 'Online now' : 'Offline'}"></span>
            ${p.lastLocation ? `<span class="leader-coord-badge" title="Last known coordinates">📍 ${escapeHtml(p.lastLocation)}</span>` : ''}
          </div>
          <div class="leader-sub-info">
            <span>First joined: ${formatRelativeTime(p.firstSeen)}</span>
            <span>•</span>
            <span>Last active: ${isOnline ? '<strong style="color:var(--green)">Now</strong>' : formatRelativeTime(p.lastSeen)}</span>
            <span>•</span>
            <span>Sessions: ${p.sessionCount || 1}</span>
          </div>
        </div>

        <div class="leader-stats-bar">
          <div class="l-stat-item" title="Total Uptime / Playtime">
            <span class="l-stat-val">⏳ ${p.uptimeFormatted}</span>
            <span class="l-stat-lbl">Uptime</span>
          </div>
          <div class="l-stat-item" title="Creatures & Bosses Slayed">
            <span class="l-stat-val" style="color:var(--gold-bright)">⚔️ ${p.kills}</span>
            <span class="l-stat-lbl">Kills</span>
          </div>
          <div class="l-stat-item" title="Deaths in battle">
            <span class="l-stat-val" style="color:var(--red)">💀 ${p.deaths}</span>
            <span class="l-stat-lbl">Deaths</span>
          </div>
          <div class="l-stat-item" title="Kill / Death Ratio">
            <span class="l-stat-val">⚖️ ${p.kdRatio}</span>
            <span class="l-stat-lbl">K/D</span>
          </div>
          <div class="l-stat-item" title="Structures Built">
            <span class="l-stat-val">🔨 ${p.builds}</span>
            <span class="l-stat-lbl">Built</span>
          </div>
          <div class="l-stat-item" title="Resources Mined">
            <span class="l-stat-val">⛏️ ${p.harvests}</span>
            <span class="l-stat-lbl">Mined</span>
          </div>
        </div>

        <div class="leader-action">
          <button class="btn-chronicle" onclick="event.stopPropagation(); openPlayerModal('${escapeHtml(p.name)}')">
            📜 Chronicle ▾
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function filterLeaderboard() {
  if (!rawLeaderboardData || !Array.isArray(rawLeaderboardData.players)) return;
  const q = (document.getElementById('leaderSearchInput')?.value || '').trim().toLowerCase();
  let filtered = rawLeaderboardData.players.slice();
  if (q) {
    filtered = filtered.filter(p => p.name.toLowerCase().includes(q));
  }
  sortAndRenderFiltered(filtered);
}

function sortLeaderboard() {
  if (!rawLeaderboardData || !Array.isArray(rawLeaderboardData.players)) return;
  filterLeaderboard();
}

function sortAndRenderFiltered(list) {
  const sortKey = document.getElementById('leaderSortSelect')?.value || 'score';
  list.sort((a, b) => {
    if (sortKey === 'uptime') return b.uptimeMs - a.uptimeMs;
    if (sortKey === 'kills') return b.kills - a.kills;
    if (sortKey === 'deaths') return b.deaths - a.deaths;
    if (sortKey === 'builds') return b.builds - a.builds;
    if (sortKey === 'harvests') return b.harvests - a.harvests;
    return b.score - a.score || b.uptimeMs - a.uptimeMs;
  });
  renderLeaderboardList(list);
}

async function openPlayerModal(playerName) {
  const modal = document.getElementById('playerStatsModal');
  if (!modal) return;

  currentChroniclePlayer = playerName;
  modal.classList.remove('hidden');

  // Set loading placeholder
  document.getElementById('modalPlayerName').textContent = playerName;
  document.getElementById('modalPlayerUptime').textContent = '...';
  document.getElementById('modalPlayerKills').textContent = '...';
  document.getElementById('modalPlayerDeaths').textContent = '...';
  document.getElementById('modalPlayerKd').textContent = '...';
  document.getElementById('modalPlayerBuilds').textContent = '...';
  document.getElementById('modalPlayerHarvests').textContent = '...';
  document.getElementById('modalKillsBreakdown').innerHTML = '<span>Consulting runestones...</span>';
  document.getElementById('modalBuildsBreakdown').innerHTML = '<span>Consulting runestones...</span>';
  document.getElementById('modalHarvestsBreakdown').innerHTML = '<span>Consulting runestones...</span>';
  document.getElementById('modalRecentEvents').innerHTML = '<span>Loading saga...</span>';

  try {
    const res = await apiFetch(`/api/leaderboard/player/${encodeURIComponent(playerName)}`);
    if (!res.ok) throw new Error('Player stats not found');
    const p = await res.json();
    populatePlayerModal(p);
  } catch (err) {
    document.getElementById('modalRecentEvents').innerHTML = `<span style="color:var(--red)">${err.message}</span>`;
  }
}

function populatePlayerModal(p) {
  document.getElementById('modalPlayerName').textContent = p.name;
  const isOnline = p.status === 'online';
  const statusEl = document.getElementById('modalPlayerStatus');
  if (statusEl) {
    statusEl.textContent = isOnline ? 'Online Now' : 'Offline';
    statusEl.className = `status-pill ${isOnline ? 'online' : 'offline'}`;
  }

  // Titles
  const rankBadge = document.getElementById('modalPlayerRankBadge');
  if (rankBadge) {
    let title = 'Viking Explorer';
    if (p.kills >= 50) title = 'Legendary Berserker';
    else if (p.kills >= 20) title = 'Beast Slayer';
    else if (p.builds >= 30) title = 'Master Architect';
    else if (p.harvests >= 30) title = 'Grand Prospector';
    else if (p.deaths >= 15) title = 'Survivor of Valhalla';
    rankBadge.textContent = `${title} • ${p.sessionCount || 1} Journeys`;
  }

  // Numbers
  document.getElementById('modalPlayerUptime').textContent = p.uptimeFormatted;
  document.getElementById('modalPlayerKills').textContent = p.kills;
  document.getElementById('modalPlayerDeaths').textContent = p.deaths;
  document.getElementById('modalPlayerKd').textContent = p.kdRatio;
  document.getElementById('modalPlayerBuilds').textContent = p.builds;
  document.getElementById('modalPlayerHarvests').textContent = p.harvests;

  // Location Card
  const locCard = document.getElementById('modalPlayerLocationCard');
  const locCoords = document.getElementById('modalPlayerCoords');
  if (p.lastLocation) {
    locCoords.textContent = p.lastLocation;
    locCard.classList.remove('hidden');
  } else {
    locCard.classList.add('hidden');
  }

  // Kills breakdown chips
  const killsEl = document.getElementById('modalKillsBreakdown');
  const killEntries = Object.entries(p.killsBreakdown || {});
  if (killEntries.length > 0) {
    killsEl.innerHTML = killEntries.map(([target, count]) => `
      <span class="breakdown-chip kill-chip">
        <span class="chip-label">⚔️ ${escapeHtml(target)}</span>
        <span class="chip-count">x${count}</span>
      </span>
    `).join('');
  } else {
    killsEl.innerHTML = '<span class="empty-chip-note">No creatures recorded in combat yet.</span>';
  }

  // Last death cause
  const lastDeathRow = document.getElementById('modalLastDeathRow');
  const lastDeathCause = document.getElementById('modalLastDeathCause');
  if (p.lastDeathCause) {
    lastDeathCause.textContent = `${p.lastDeathCause}${p.lastDeathLocation ? ` (at ${p.lastDeathLocation})` : ''}`;
    lastDeathRow.classList.remove('hidden');
  } else {
    lastDeathRow.classList.add('hidden');
  }

  // Builds breakdown chips
  const buildsEl = document.getElementById('modalBuildsBreakdown');
  const buildEntries = Object.entries(p.buildsBreakdown || {});
  if (buildEntries.length > 0) {
    buildsEl.innerHTML = buildEntries.map(([item, count]) => `
      <span class="breakdown-chip build-chip">
        <span class="chip-label">🔨 ${escapeHtml(item)}</span>
        <span class="chip-count">x${count}</span>
      </span>
    `).join('');
  } else {
    buildsEl.innerHTML = '<span class="empty-chip-note">No structures placed yet.</span>';
  }

  // Harvests breakdown chips
  const harvestsEl = document.getElementById('modalHarvestsBreakdown');
  const harvestEntries = Object.entries(p.harvestsBreakdown || {});
  if (harvestEntries.length > 0) {
    harvestsEl.innerHTML = harvestEntries.map(([resource, count]) => `
      <span class="breakdown-chip harvest-chip">
        <span class="chip-label">⛏️ ${escapeHtml(resource)}</span>
        <span class="chip-count">x${count}</span>
      </span>
    `).join('');
  } else {
    harvestsEl.innerHTML = '<span class="empty-chip-note">No raw resources harvested yet.</span>';
  }

  // Recent timeline
  const recentEl = document.getElementById('modalRecentEvents');
  const events = p.recentEvents || [];
  if (events.length > 0) {
    recentEl.innerHTML = events.map(e => `
      <div class="m-event-item">
        <span class="m-event-time">${e.dateStr || ''}</span>
        <span class="m-event-title ${e.severity || 'info'}">${escapeHtml(e.title || 'Event')}</span>
        <span class="m-event-details">${escapeHtml(e.details || '')}</span>
        ${e.location ? `<span class="m-event-loc">📍 ${escapeHtml(e.location)}</span>` : ''}
      </div>
    `).join('');
  } else {
    recentEl.innerHTML = '<span class="empty-chip-note">No recent logged actions.</span>';
  }
}

function switchChronicleTab(tab) {
  const btnCombat = document.getElementById('cNavCombat');
  const btnEng = document.getElementById('cNavEngineering');
  const btnHist = document.getElementById('cNavHistory');
  const paneCombat = document.getElementById('cTabCombat');
  const paneEng = document.getElementById('cTabEngineering');
  const paneHist = document.getElementById('cTabHistory');

  if (btnCombat) btnCombat.classList.toggle('active', tab === 'combat');
  if (btnEng) btnEng.classList.toggle('active', tab === 'engineering');
  if (btnHist) btnHist.classList.toggle('active', tab === 'history');

  if (paneCombat) paneCombat.classList.toggle('hidden', tab !== 'combat');
  if (paneEng) paneEng.classList.toggle('hidden', tab !== 'engineering');
  if (paneHist) paneHist.classList.toggle('hidden', tab !== 'history');
}

function closePlayerModal(e) {
  if (e && e.target && e.target.classList.contains('warrior-chronicle-modal')) return;
  const modal = document.getElementById('playerStatsModal');
  if (modal) modal.classList.add('hidden');
}

function copyModalCoords() {
  const coords = document.getElementById('modalPlayerCoords')?.textContent || '';
  if (coords) {
    navigator.clipboard.writeText(coords).then(() => {
      showToast(`Coordinates copied: ${coords}`);
    }).catch(() => {
      showToast(coords);
    });
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
(function bootstrap() {
  if (loadSession()) {
    initDashboard();
  } else {
    showView('login');
  }
})();
