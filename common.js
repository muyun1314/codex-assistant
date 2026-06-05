// ============================================================
// Codex Assistant — Common (shared state, API, theme, nav, status)
// ============================================================

// ---------- State ----------
let providers = { providers: [] };
let statusTimer = null;
let currentDefaultProvider = '';
let currentTheme = localStorage.getItem('codex-assistant-theme') || 'system';
let currentAppliedModel = '';
let currentAuxModel = '';

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
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/\n/g, '<br>');
}

function openExternal(url) {
  api('/api/open-url', 'POST', { url: url });
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Status Polling ----------
async function loadStatus() {
  try {
    var s = await api('/api/status');
    setStatusUI(s);
    localStorage.setItem('codex-assistant-running', s.running ? '1' : '0');
  } catch (e) {
    setStatusUI({ running: false, error: e.message });
    localStorage.setItem('codex-assistant-running', '0');
  }
}

function startStatusLoop() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(loadStatus, 5000);
}

function startUptimeTicker() {
  setInterval(function () {
    var el = document.getElementById('uptime-display');
    if (!el || !el.dataset.start) return;
    var started = parseInt(el.dataset.start);
    if (!started) return;
    var diff = Math.floor((Date.now() - started * 1000) / 1000);
    el.textContent = formatUptime(diff);
  }, 1000);
}

async function loadStats() {
  try {
    var stats = await api('/api/stats');
    document.getElementById('stat-total-requests').textContent = stats.totalRequests || 0;
    document.getElementById('stat-active-providers').textContent = stats.activeProviders || 0;
    document.getElementById('stat-total-models').textContent = stats.totalModels || 0;
    document.getElementById('stat-uptime').textContent = formatUptime(stats.uptimeSeconds || 0);
  } catch (e) { /* non-critical */ }
}

function formatUptime(s) {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}

// ---------- Status UI ----------
function setStatusUI(s) {
  var dot = document.getElementById('status-dot');
  var text = document.getElementById('status-text');
  var msgEl = document.getElementById('status-message');
  var uptimeEl = document.getElementById('uptime-display');
  var btnStartStop = document.getElementById('btn-start-stop');
  var btnApplyConfig = document.getElementById('btn-apply-config');

  if (s.running) {
    dot.className = 'status-dot on';
    text.textContent = '运行中';
    text.className = '';
    if (msgEl) msgEl.textContent = '';
    if (btnStartStop) { btnStartStop.textContent = '停止'; btnStartStop.className = 'btn btn-danger'; }
    if (btnApplyConfig) btnApplyConfig.disabled = false;
    if (uptimeEl && s.startedAt) {
      uptimeEl.dataset.start = String(Math.floor(s.startedAt / 1000));
    }
  } else {
    dot.className = 'status-dot off';
    text.textContent = '未运行';
    text.className = 'text-danger';
    if (msgEl && s.error) msgEl.textContent = s.error;
    if (btnStartStop) { btnStartStop.textContent = '启动'; btnStartStop.className = 'btn btn-success'; }
    if (btnApplyConfig) btnApplyConfig.disabled = true;
  }
}

// ---------- Model Display ----------
function updateCurrentModelDisplay(allModels) {
  // Update main model badge
  var badge = document.getElementById('current-model-badge');
  if (badge && currentAppliedModel) {
    var found = allModels.find(function(m) { return m.slug === currentAppliedModel; });
    badge.textContent = found ? (found.name || found.slug) : currentAppliedModel;
    badge.style.display = '';
  } else if (badge) {
    badge.style.display = 'none';
  }

  // Update main model select
  var sel = document.getElementById('model-select');
  if (sel) {
    fillModelSelectOptions(sel, allModels);
    if (currentAppliedModel) {
      sel.value = currentAppliedModel;
    }
  }

  // Update aux model select
  var auxSel = document.getElementById('aux-model-select');
  if (auxSel) {
    fillModelSelectOptions(auxSel, allModels);
    if (currentAuxModel) {
      auxSel.value = currentAuxModel;
    }
  }
}

function fillModelSelectOptions(sel, allModels) {
  if (!sel) return;
  // Build grouped options
  var seenProviders = {};
  var html = '<option value="">自动选择</option>';
  allModels.forEach(function(m) {
    if (!seenProviders[m.provider]) {
      seenProviders[m.provider] = true;
    }
    html += '<option value="' + escAttr(m.slug) + '">' + escHtml(m.name || m.slug) + '</option>';
  });
  sel.innerHTML = html;
}

function fillModelSelect() {
  var allModels = [];
  (providers.providers || []).forEach(function(p) {
    (p.models || []).forEach(function(m) {
      allModels.push({ slug: m.slug || m.id, name: m.display_name || m.id, provider: p.name });
    });
  });
  updateCurrentModelDisplay(allModels);
}

function onProviderChange() {
  // Refresh model select when default provider changes
  var sel = document.getElementById('default-provider-select');
  if (sel) {
    currentDefaultProvider = sel.value;
  }
}

function onAuxProviderChange() {
  var sel = document.getElementById('aux-provider-select');
  if (sel) {
    // Aux provider change doesn't auto-change the model, user picks
  }
}

function fillAuxProviderSelect() {
  var sel = document.getElementById('aux-provider-select');
  if (!sel) return;
  var html = '<option value="">不使用副模型</option>';
  (providers.providers || []).forEach(function(p) {
    var name = p.name || p.id;
    var status = (p.status === 'connected' || p.status === 'active') ? '' : ' (未连接)';
    html += '<option value="' + escAttr(name) + '">' + escHtml(name) + status + '</option>';
  });
  sel.innerHTML = html;
}
