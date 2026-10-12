/* ═══════════════════════════════════════════════════════════════
   VALHEIM ADMIN – Frontend Logic
   ═══════════════════════════════════════════════════════════════ */

let authToken = null;
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
function saveSession(token) {
  authToken = token;
  sessionStorage.setItem('vh_token', token);
}

function loadSession() {
  const token = sessionStorage.getItem('vh_token');
  if (token) {
    authToken = token;
    return true;
  }
  return false;
}

function clearSession() {
  authToken = null;
  sessionStorage.removeItem('vh_token');
}

// ─── API helper ───────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 || res.status === 403) {
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
      saveSession(data.token);
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
  fetchStatus();
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

function copyJoinCode() {
  const code = document.getElementById('infoJoinCode').dataset.code;
  if (!code) return;
  copyToClipboard(code, document.getElementById('btnCopyJoin'));
}

function copyAddress() {
  copyToClipboard('172.105.121.226:2456', event.currentTarget);
}

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    flashCopied(btn);
  }).catch(() => {
    // Fallback for non-secure HTTP contexts
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    flashCopied(btn);
  });
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

  const es = new EventSource(`/api/logs?t=${authToken}`, {});

  // SSE doesn't support custom headers, so we pass token as query param
  // The actual SSE endpoint re-reads the token from the URL
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
  if (l.includes('error') || l.includes('exception') || l.includes('fatal')) return 'error';
  if (l.includes('warn'))  return 'warn';
  if (l.includes('info') || l.includes('starting') || l.includes('loaded')) return 'info';
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

// ─── Bootstrap ───────────────────────────────────────────────────────────────
(function bootstrap() {
  if (loadSession()) {
    initDashboard();
  } else {
    showView('login');
  }
})();
