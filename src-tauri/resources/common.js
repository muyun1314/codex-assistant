// Dependencies: none (base module)
// ============================================================
// Codex Assistant — UI Controller
// ============================================================

// ---------- State ----------
let providers = { providers: [] };
let statusTimer = null;
let currentDefaultProvider = '';
let currentTheme = localStorage.getItem('codex-assistant-theme') || 'system';

// ---------- Theme ----------
function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getEffectiveTheme() {
  if (currentTheme === 'system') {
    return getSystemTheme();
  }
  return currentTheme;
}

function setTheme(theme) {
  currentTheme = theme;
  localStorage.setItem('codex-assistant-theme', theme);
  applyTheme();
  updateThemeUI();
  updateThemeRadioUI();
}

function toggleTheme() {
  const themes = ['system', 'light', 'dark'];
  const currentIndex = themes.indexOf(currentTheme);
  const nextTheme = themes[(currentIndex + 1) % themes.length];
  setTheme(nextTheme);
}

function updateThemeUI() {
  const btn = document.getElementById('btn-theme');
  const icon = document.getElementById('icon-theme');
  if (!btn || !icon) return;

  const effective = getEffectiveTheme();
  if (currentTheme === 'system') {
    btn.querySelector('span').textContent = '跟随系统';
    icon.innerHTML = '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line>';
  } else if (effective === 'dark') {
    btn.querySelector('span').textContent = '深色模式';
    icon.innerHTML = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
  } else {
    btn.querySelector('span').textContent = '浅色模式';
    icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
  }
}

function updateThemeRadioUI() {
  const radio = document.querySelector('input[name="theme-mode"][value="' + currentTheme + '"]');
  if (radio) radio.checked = true;
}

function applyTheme() {
  const effective = getEffectiveTheme();
  document.body.className = effective === 'light' ? 'theme-light' : '';
  updateThemeUI();
}

// 监听系统主题变化
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
  if (currentTheme === 'system') {
    applyTheme();
  }
});

// ---------- CSRF Token ----------
var csrfToken = '';

function initCsrfToken() {
  var meta = document.querySelector('meta[name="csrf-token"]');
  if (meta) {
    csrfToken = meta.getAttribute('content') || '';
  } else {
    console.warn('[ui] CSRF token not found in page — API writes will fail');
  }
}
let toastTimer = null;
function toast(msg, type) {
  type = type || 'success';
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show toast-' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3200);
}

// ---------- API ----------
var API_TIMEOUT_MS = 30000; // 30s timeout for all API calls

async function api(path, method, body) {
  method = method || 'GET';
  var opts = { method: method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  // Include CSRF token for all write requests
  if (method !== 'GET' && csrfToken) {
    opts.headers['X-CSRF-Token'] = csrfToken;
  }
  // AbortController timeout to prevent hung requests
  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, API_TIMEOUT_MS);
  opts.signal = controller.signal;

  try {
    var res = await fetch(path, opts);
    clearTimeout(timeoutId);
    return res.json();
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      toast('请求超时，请检查服务是否正常运行', 'error');
      throw new Error('Request timed out after ' + (API_TIMEOUT_MS / 1000) + 's');
    }
    throw e;
  }
}

// ---------- Navigation ----------
function showPage(id, navEl) {
  // Pages
  document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
  var page = document.getElementById('page-' + id);
  if (page) page.classList.add('active');

  // Nav
  document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('active'); });
  if (navEl) navEl.classList.add('active');

  // Per-page init
  if (id === 'logs') { loadLogs(); loadLogConfig(); }
  if (id === 'env') {
    // Fast calls first, so they don't queue behind slow codex checks
    loadEnv();
    setTimeout(function() { loadCodexppConfig(); }, 100);
  }
  if (id === 'settings') { loadCloseBehavior(); loadBackupList(); }
  if (id === 'providers') { loadProviders(); }
}

// ---------- HTML Escape ----------
function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderMarkdown(md) {
  if (!md) return '';
  var raw = (md + '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  raw = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  var lines = raw.split('\n');
  var out = '';
  var inUl = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) { if (inUl) { out += '</ul>'; inUl = false; } continue; }
    if (/^### .+/.test(line)) { if (inUl) { out += '</ul>'; inUl = false; } out += '<h3>' + escHtml(line.slice(4)) + '</h3>'; }
    else if (/^## .+/.test(line)) { if (inUl) { out += '</ul>'; inUl = false; } out += '<h2>' + escHtml(line.slice(3)) + '</h2>'; }
    else if (/^# .+/.test(line)) { if (inUl) { out += '</ul>'; inUl = false; } out += '<h1>' + escHtml(line.slice(2)) + '</h1>'; }
    else if (/^- .+/.test(line)) { if (!inUl) { out += '<ul>'; inUl = true; } out += '<li>' + escHtml(line.slice(2)).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>') + '</li>'; }
    else { if (inUl) { out += '</ul>'; inUl = false; } out += '<p>' + escHtml(line).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>') + '</p>'; }
  }
  if (inUl) { out += '</ul>'; }
  return out;
}

function openExternal(url) {
  api('/api/open-url', 'POST', { url: url });
}

function escAttr(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ==================== Status & Dashboard ====================

var lastProxyRunning = null;
var manualStopPending = false;  // 标记：用户是否刚刚手动点击了停止代理

async function loadStatus() {
  try {
    var d = await api('/api/status');

    // Detect proxy crash
    if (manualStopPending && lastProxyRunning === true && !d.proxy_running) {
      manualStopPending = false;
      toast('代理已停止');
    } else if (lastProxyRunning === true && !d.proxy_running) {
      try {
        var logs = await api('/api/logs');
        var recentErrors = (logs.logs || []).filter(function (l) {
          return l.type === 'stderr' || (l.type === 'system' && l.msg.indexOf('退出') !== -1);
        }).slice(-3);
        if (recentErrors.length > 0) {
          toast('代理意外停止，请检查运行日志', 'error');
        }
      } catch (e) { /* transient failure, will retry */ }
    }
    lastProxyRunning = d.proxy_running;

    // Proxy status
    var dotP = document.getElementById('s-dot-proxy');
    var txtP = document.getElementById('s-text-proxy');
    dotP.className = 'status-dot ' + (d.proxy_running ? 'running' : 'stopped');
    txtP.textContent = d.proxy_running ? '运行中' : '已停止';

    var btnP = document.getElementById('btn-proxy');
    btnP.textContent = d.proxy_running ? '停止代理' : '启动代理';
    btnP.className = d.proxy_running ? 'btn btn-danger' : 'btn btn-primary';

    // Codex status
    var dotC = document.getElementById('s-dot-codex');
    var txtC = document.getElementById('s-text-codex');
    dotC.className = 'status-dot ' + (d.codex_running ? 'running' : 'stopped');
    txtC.textContent = d.codex_running ? '运行中' : '未运行';

    // Port
    document.getElementById('s-port').textContent = d.port || '4000';

    // Refresh stats when proxy is running and we haven't got data yet
    // (retries on next loop if first attempt fails due to race condition)
    if (d.proxy_running && _uptimeTs === 0) { loadStats(); }
    if (!d.proxy_running && _uptimeTs !== 0) {
      _uptimeBase = 0; _uptimeTs = 0;
      var uptimeEl = document.getElementById('s-uptime');
      if (uptimeEl) uptimeEl.textContent = '--';
    }

    // Model count
    var pd = await api('/api/providers');
    var totalModels = (pd.providers || []).reduce(function (s, p) { return s + (p.models || []).length; }, 0);
    document.getElementById('s-models').textContent = totalModels;

    // Update dropdowns
    fillModelSelect();
  } catch (e) { /* transient failure, will retry */ }
}

function startStatusLoop() {
  loadStatus();
  loadStats();
  statusTimer = setInterval(function () { loadStatus(); }, 5000);
}

// ==================== Stats ====================

var _uptimeBase = 0;    // server-reported seconds
var _uptimeTs = 0;      // local timestamp when we got it

function startUptimeTicker() {
  setInterval(function () {
    var el = document.getElementById('s-uptime');
    if (!el) return;
    if (_uptimeTs === 0) { el.textContent = '--'; return; }
    var total = _uptimeBase + Math.floor((Date.now() - _uptimeTs) / 1000);
    el.textContent = formatUptime(total);
  }, 200);
}

async function loadStats() {
  try {
    var d = await api('/api/stats');
    if (!d || d.proxy_offline) {
      _uptimeBase = 0; _uptimeTs = 0;
      var uptimeEl = document.getElementById('s-uptime');
      if (uptimeEl) uptimeEl.textContent = '--';
      return;
    }
    _uptimeBase = d.uptime_seconds || 0;
    _uptimeTs = Date.now();
  } catch (e) { /* transient failure, will retry */ }
}

function formatUptime(s) {
  var sec = s % 60;
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + sec + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ' + sec + 's';
}

