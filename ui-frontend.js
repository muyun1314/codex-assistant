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
    txtP.textContent = d.proxy_running ? (d.proxy_external_alive ? '运行中（外部）' : '运行中') : '已停止';

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

// ==================== Model Display ====================

var currentAppliedModel = '';
var currentAuxModel = '';

function updateCurrentModelDisplay(allModels) {
  var cardEl = document.getElementById('model-display-card');
  var displayEl = document.getElementById('current-model-display');
  if (!displayEl || !cardEl) return;

  // If the configured model no longer exists in providers, treat as unset
  if (currentAppliedModel && !allModels.some(function (m) { return m.slug === currentAppliedModel; })) {
    currentAppliedModel = '';
    currentAuxModel = '';
  }

  if (!currentAppliedModel) {
    cardEl.style.display = 'block';
    if (allModels && allModels.length > 0) {
      displayEl.innerHTML = '<div class="model-display-value" style="color:var(--text-muted);">请配置 Codex 的提供商和模型信息并应用</div>';
    } else {
      displayEl.innerHTML = '<div class="model-display-value" style="color:var(--text-muted);">请至少配置一个提供商</div>';
    }
    return;
  }
  cardEl.style.display = 'block';

  var mainModel = allModels.find(function (m) { return m.slug === currentAppliedModel; });
  var mainName = mainModel ? mainModel.name : currentAppliedModel;
  var mainColor = mainModel ? 'var(--success)' : 'var(--error)';

  var auxText = '跟随主模型';
  var auxColor = 'var(--success)';
  if (currentAuxModel && currentAuxModel !== currentAppliedModel) {
    var auxModel = allModels.find(function (m) { return m.slug === currentAuxModel; });
    auxText = auxModel ? auxModel.name : currentAuxModel;
    auxColor = auxModel ? 'var(--accent)' : 'var(--error)';
  }

  displayEl.innerHTML =
    '<div class="model-display-item">' +
      '<span class="model-display-label">主模型</span>' +
      '<span class="model-display-value" style="color:' + mainColor + ';">' + escHtml(mainName) + '</span>' +
    '</div>' +
    '<div class="model-display-item">' +
      '<span class="model-display-label">辅助模型</span>' +
      '<span class="model-display-value" style="color:' + auxColor + ';">' + escHtml(auxText) + '</span>' +
    '</div>';
}

// ==================== Model Select Dropdowns ====================

function fillModelSelect() {
  var providerSelect = document.getElementById('quick-provider');
  var modelSelect = document.getElementById('quick-model');
  if (!providerSelect || !modelSelect) return;

  var currentProvider = providerSelect.value;
  var currentModel = modelSelect.value;

  var providerList = providers.providers || [];
  providerSelect.innerHTML = providerList.length === 0
    ? '<option value="">暂无提供商</option>'
    : '<option value="">选择提供商</option>' + providerList.map(function (p) {
        return '<option value="' + escAttr(p.name) + '">' + escHtml(p.name) + '</option>';
      }).join('');

  if (currentProvider && providerList.some(function (p) { return p.name === currentProvider; })) {
    providerSelect.value = currentProvider;
  }

  onProviderChange();

  var modelSelectAfter = document.getElementById('quick-model');
  if (currentModel && modelSelectAfter) {
    var opts = modelSelectAfter.options;
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].value === currentModel) { modelSelectAfter.value = currentModel; break; }
    }
  }

  fillAuxProviderSelect();

  var allModels = [];
  providerList.forEach(function (p) {
    (p.models || []).forEach(function (m) {
      allModels.push({ slug: m.slug || m.id, name: m.display_name || m.id, provider: p.name });
    });
  });
  updateCurrentModelDisplay(allModels);
}

function onProviderChange() {
  var providerSelect = document.getElementById('quick-provider');
  var modelSelect = document.getElementById('quick-model');
  if (!providerSelect || !modelSelect) return;

  var selectedProvider = providerSelect.value;
  var provider = (providers.providers || []).find(function (p) { return p.name === selectedProvider; });

  if (provider && provider.models && provider.models.length > 0) {
    modelSelect.innerHTML = provider.models.map(function (m) {
      var slug = m.slug || m.id;
      var name = m.display_name || m.id;
      return '<option value="' + escAttr(slug) + '">' + escHtml(name) + '</option>';
    }).join('');
  } else {
    modelSelect.innerHTML = '<option value="">请先选择提供商</option>';
  }
}

function onAuxProviderChange() {
  var providerSelect = document.getElementById('quick-aux-provider');
  var modelSelect = document.getElementById('quick-aux-model');
  if (!providerSelect || !modelSelect) return;

  var selectedProvider = providerSelect.value;
  if (!selectedProvider) {
    modelSelect.innerHTML = '<option value="">跟随主模型</option>';
    return;
  }
  var provider = (providers.providers || []).find(function (p) { return p.name === selectedProvider; });
  if (provider && provider.models && provider.models.length > 0) {
    modelSelect.innerHTML = provider.models.map(function (m) {
      var slug = m.slug || m.id;
      var name = m.display_name || m.id;
      return '<option value="' + escAttr(slug) + '">' + escHtml(name) + '</option>';
    }).join('');
  } else {
    modelSelect.innerHTML = '<option value="">该提供商无模型</option>';
  }
}

function fillAuxProviderSelect() {
  var providerSelect = document.getElementById('quick-aux-provider');
  if (!providerSelect) return;

  var currentProvider = providerSelect.value;
  var currentModel = document.getElementById('quick-aux-model') ? document.getElementById('quick-aux-model').value : '';
  var providerList = providers.providers || [];

  providerSelect.innerHTML = '<option value="">跟随主模型</option>' +
    providerList.map(function (p) {
      return '<option value="' + escAttr(p.name) + '">' + escHtml(p.name) + '</option>';
    }).join('');

  if (currentProvider && providerList.some(function (p) { return p.name === currentProvider; })) {
    providerSelect.value = currentProvider;
    onAuxProviderChange();
    var modelSelect = document.getElementById('quick-aux-model');
    if (currentModel && modelSelect) {
      var opts = modelSelect.options;
      for (var i = 0; i < opts.length; i++) {
        if (opts[i].value === currentModel) { modelSelect.value = currentModel; break; }
      }
    }
  }
}

// ==================== Agent / Codex Control ====================

async function toggleProxy() {
  var d = await api('/api/status');
  if (d.proxy_running) {
    manualStopPending = true;
    await api('/api/proxy/stop', 'POST');
    toast('正在停止代理...');
    setTimeout(loadStatus, 500);
    return;
  }
  
  // Check if any providers are configured
  var pd = await api('/api/providers');
  var providerCount = (pd.providers || []).length;
  if (providerCount === 0) {
    toast('请先在"提供商管理"中添加至少一个提供商', 'error');
    return;
  }

  // Check if user has applied a model to Codex
  if (!currentAppliedModel) {
    toast('请先在"提供商管理"中选择模型并点击"应用到 Codex"，然后再启动代理', 'warning');
    return;
  }
  
  var result = await api('/api/proxy/start', 'POST');
  if (result.success && result.port) {
    document.getElementById('s-port').textContent = result.port;
    var msg = '代理已启动，端口: ' + result.port;
    if (result.synced && result.synced.length > 0) {
      msg += '\n' + result.synced.join('\n');
    }
    toast(msg);
    // 刷新状态
    setTimeout(loadStatus, 500);
  } else {
    toast(result.message || '启动失败', 'error');
  }
}

async function restartProxy() {
  toast('正在重启代理...');
  var result = await api('/api/proxy/restart', 'POST');
  if (result.success) {
    var msg = '代理重启成功';
    if (result.port) msg += '，端口: ' + result.port;
    if (result.synced && result.synced.length > 0) {
      msg += '\n' + result.synced.join('\n');
    }
    toast(msg);
  } else {
    toast(result.message || '代理重启失败', 'error');
  }
  loadStatus();
}

async function startCodex(mode) {
  // Must have a model configured before starting proxy
  if (!currentAppliedModel) {
    toast('请先在"快速配置 Codex"中选择模型并点击"应用配置到 Codex"，然后再启动', 'warning');
    return;
  }

  var status = await api('/api/status');
  if (!status.proxy_running) {
    toast('代理未运行，正在启动代理...');
    var proxyResult = await api('/api/proxy/start', 'POST');
    if (proxyResult.success) {
      toast('代理已启动');
      await new Promise(function (r) { setTimeout(r, 500); });
    } else {
      toast('代理启动失败: ' + (proxyResult.message || '未知错误'), 'error');
      return;
    }
  }

  var endpoint;
  switch (mode) {
    case 'cli': endpoint = '/api/codex/start-cli'; break;
    case 'app': endpoint = '/api/codex/start-app'; break;
    case 'codexpp': endpoint = '/api/codex/start-codexpp'; break;
    case 'codexpp-manager': endpoint = '/api/codex/start-codexpp-manager'; break;
    default: endpoint = '/api/codex/start-cli';
  }
  var result = await api(endpoint, 'POST');
  if (result.success) {
    toast(result.message);
  } else {
    toast(result.message || '启动失败', 'error');
  }
  setTimeout(loadStatus, 500);
}

async function stopCodex() {
  var status = await api('/api/status');
  var type = 'all';
  if (status.codex_running_type) {
    if (status.codex_running_type === 'codexpp') type = 'codexpp';
    else if (status.codex_running_type === 'cli') type = 'cli';
    else type = 'app';
  }
  var result = await api('/api/codex/stop', 'POST', { type: type });
  toast(result.message || 'Codex 已停止');
  loadStatus();
}

async function checkCodexInstalled() {
  // 四项独立检测，各自并行，完成一项就更新一项 UI
  api('/api/codex/check-cli').then(function(r) {
    var cliBtn = document.getElementById('btn-codex-cli');
    if (cliBtn) {
      cliBtn.disabled = !r.ok;
      cliBtn.title = r.ok ? '启动 Codex CLI' : '未安装 Codex CLI';
    }
  }).catch(function(){});

  api('/api/codex/check-desktop').then(function(r) {
    var appBtn = document.getElementById('btn-codex-app');
    if (appBtn) {
      appBtn.disabled = !r.ok;
      var codexType = r.type || 'exe';
      appBtn.textContent = '启动 Codex 桌面版';
      appBtn.title = r.ok ? '启动 Codex 桌面版' : '未安装 Codex';
    }
  }).catch(function(){});

  api('/api/codex/check-plusplus').then(function(r) {
    var cppBtn = document.getElementById('btn-codexpp');
    if (cppBtn) cppBtn.disabled = !r.ok;
  }).catch(function(){});

  api('/api/codex/check-plusplus-manager').then(function(r) {
    var mgrBtn = document.getElementById('btn-codexpp-manager');
    if (mgrBtn) mgrBtn.disabled = !r.ok;
  }).catch(function(){});
}

// ==================== Codex Backup & Restore ====================

async function loadBackupList() {
  try {
    var d = await api('/api/codex-backup/list');
    var statusEl = document.getElementById('backup-status');
    var listEl = document.getElementById('backup-list');
    if (d.isModified) {
      statusEl.innerHTML = '✓ Codex 配置已被 Codex Assistant 修改（自动备份已完成）';
      statusEl.style.color = 'var(--success)';
    } else {
      statusEl.innerHTML = '⚠ Codex 配置未被修改（由 Codex 或其他工具管理）';
      statusEl.style.color = 'var(--warning)';
    }
    if (!d.backups || d.backups.length === 0) {
      listEl.innerHTML = '<div style="color:var(--text-muted);font-size:var(--text-sm);padding:var(--space-2);">暂无备份</div>';
      return;
    }
    listEl.innerHTML = d.backups.map(function (b) {
      var date = new Date(b.time);
      var dateStr = date.getFullYear() + '年' +
        String(date.getMonth()+1).padStart(2,'0') + '月' +
        String(date.getDate()).padStart(2,'0') + '日 ' +
        String(date.getHours()).padStart(2,'0') + ':' +
        String(date.getMinutes()).padStart(2,'0');
      var isAuto = b.name.includes('自动') || b.name.includes('auto');
      var nameShort = b.name.replace(/\.zip$/i, '');
      // Lock SVG icon
      var lockSvg = b.locked
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="backup-lock-icon locked"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="backup-lock-icon"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path><line x1="12" y1="15" x2="12" y2="19"></line></svg>';
      // Folder SVG icon
      var folderSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="backup-action-icon"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
      // Delete SVG icon
      var delSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="backup-action-icon"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
      return '<div class="backup-item">' +
        '<div class="backup-row1">' +
          '<button class="backup-lock-btn" onclick="toggleLockBackup(\'' + escAttr(b.name) + '\',' + !b.locked + ')" title="' + (b.locked ? '已锁定，点击解锁' : '未锁定，点击锁定') + '">' + lockSvg + '</button>' +
          '<span class="backup-name" title="' + escAttr(b.name) + '">' + escHtml(nameShort) + '</span>' +
          (isAuto ? '<span class="backup-tag">自动</span>' : '<span class="backup-tag manual">手动</span>') +
          '<span class="backup-date">' + dateStr + '</span>' +
        '</div>' +
        '<div class="backup-row2">' +
          '<button class="backup-action-btn" onclick="restoreBackup(\'' + escAttr(b.name) + '\')">恢复</button>' +
          '<button class="backup-action-btn" onclick="renameBackup(\'' + escAttr(b.name) + '\')">重命名</button>' +
          '<button class="backup-action-btn" onclick="openBackupFolder()">' + folderSvg + ' 打开文件夹</button>' +
          '<button class="backup-action-btn backup-delete-btn' + (b.locked ? ' disabled' : '') + '" onclick="' + (b.locked ? 'return' : 'deleteBackup(\'' + escAttr(b.name) + '\')') + '" title="' + (b.locked ? '已锁定，无法删除' : '删除此备份') + '"' + (b.locked ? ' disabled' : '') + '>' + delSvg + ' 删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    toast('加载备份列表失败: ' + e.message, 'error');
  }
}

async function createBackup() {
  try {
    var result = await api('/api/codex-backup/create', 'POST');
    if (result.skipped) {
      toast(result.message, 'warning');
      return;
    }
    if (!result.success) {
      throw new Error(result.error || '备份失败');
    }
    toast('备份已创建');
    await loadBackupList();
  } catch (e) {
    toast('备份失败: ' + e.message, 'error');
  }
}

async function restoreBackup(name) {
  if (!confirm('确定要恢复备份 "' + name + '" 吗？\n\n当前配置将被备份，然后恢复为备份版本。\n恢复后需要重启 Codex 才能生效。')) return;
  try {
    var result = await api('/api/codex-backup/restore', 'POST', { name: name });
    if (!result.success) {
      throw new Error(result.error || '恢复失败');
    }
    toast(result.message || '恢复成功');
    await loadBackupList();
  } catch (e) {
    toast('恢复失败: ' + e.message, 'error');
  }
}

async function deleteBackup(name) {
  if (!confirm('确定要删除备份 "' + name + '" 吗？')) return;
  try {
    var result = await api('/api/codex-backup/delete', 'POST', { name: name });
    if (!result.success) {
      throw new Error(result.error || '删除失败');
    }
    toast('备份已删除');
    await loadBackupList();
  } catch (e) {
    toast('删除失败: ' + e.message, 'error');
  }
}

async function toggleLockBackup(name, locked) {
  try {
    var result = await api('/api/codex-backup/lock', 'POST', { name: name, locked: locked });
    if (!result.success) {
      throw new Error(result.error || '操作失败');
    }
    toast(locked ? '备份已锁定' : '备份已解锁');
    await loadBackupList();
  } catch (e) {
    toast('操作失败: ' + e.message, 'error');
  }
}

async function renameBackup(name) {
  var newName = prompt('输入新的备份名称（不含 .zip 后缀）：', name.replace('codex-backup-', '').replace('.zip', ''));
  if (!newName || newName === name.replace('codex-backup-', '').replace('.zip', '')) return;
  var fullName = 'codex-backup-' + newName + '.zip';
  try {
    var result = await api('/api/codex-backup/rename', 'POST', { name: name, newName: fullName });
    if (!result.success) {
      throw new Error(result.error || '重命名失败');
    }
    toast('重命名成功');
    await loadBackupList();
  } catch (e) {
    toast('重命名失败: ' + e.message, 'error');
  }
}

function openBackupFolder() {
  api('/api/codex-backup/list').then(function (d) {
    if (d.backupDir) {
      api('/api/open-folder', 'POST', { path: d.backupDir });
    }
  });
}

// ==================== Codex++ manual path config ====================

async function loadCodexppConfig() {
  try {
    var d = await api('/api/codexpp-path');
    if (d) {
      if (d.codexppPath) document.getElementById('cfg-codexpp-path').value = d.codexppPath;
      if (d.codexppMgrPath) document.getElementById('cfg-codexpp-mgr-path').value = d.codexppMgrPath;
    }
  } catch (e) { /* transient failure, will retry */ }
}

async function selectCodexppPath() {
  var result = await api('/api/select-file', 'POST', {
    title: '选择 Codex++ 主程序 (codex-plus-plus.exe)',
    defaultPath: document.getElementById('cfg-codexpp-path').value || '',
    filter: 'codex-plus-plus.exe'
  });
  if (result && result.success && result.path) {
    document.getElementById('cfg-codexpp-path').value = result.path;
    // Auto-derive manager path from same directory
    var dir = result.path.replace(/[^\\/]+$/, '');
    var mgrPath = dir + 'codex-plus-plus-manager.exe';
    document.getElementById('cfg-codexpp-mgr-path').value = mgrPath;
    toast('已选择 Codex++ 路径');
  }
}

async function saveCodexppConfig() {
  var codexppPath = document.getElementById('cfg-codexpp-path').value.trim();
  var mgrPath = document.getElementById('cfg-codexpp-mgr-path').value.trim();
  try {
    var result = await api('/api/codexpp-path', 'POST', { codexppPath: codexppPath, codexppMgrPath: mgrPath });
    if (!result || !result.success) {
      throw new Error((result && result.error) || '保存失败');
    }
    toast('Codex++ 路径已保存');
    await checkCodexInstalled();
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
  }
}

async function autoDetectCodexpp() {
  toast('正在自动检测...');
  var result = await api('/api/codex/check-installed');
  if (result && result.codexPlusPlus) {
    // Auto-detection found it — fetch the saved/auto path
    var pathInfo = await api('/api/codexpp-path');
    if (pathInfo && pathInfo.codexppPath) {
      document.getElementById('cfg-codexpp-path').value = pathInfo.codexppPath;
      document.getElementById('cfg-codexpp-mgr-path').value = pathInfo.codexppMgrPath || '';
      toast('自动检测成功');
    } else {
      toast('自动检测成功，但未获取到路径', 'error');
    }
  } else {
    toast('未检测到 Codex++ 安装，请手动选择', 'error');
  }
}

// ==================== Quick Apply Config ====================

async function quickApply() {
  var model = document.getElementById('quick-model').value;
  var auxProvider = document.getElementById('quick-aux-provider').value;
  var auxModel = document.getElementById('quick-aux-model').value;
  var port = document.getElementById('s-port').textContent;
  if (!model) { toast('请先在提供商管理中添加模型', 'error'); return; }

  var status = await api('/api/status');
  if (!status.proxy_running) {
    toast('代理未运行，正在启动...');
    var proxyResult = await api('/api/proxy/start', 'POST');
    if (proxyResult.success) {
      await new Promise(function (r) { setTimeout(r, 500); });
    } else {
      toast('代理启动失败: ' + (proxyResult.message || '未知错误'), 'error');
      return;
    }
  }

  var actualModel = model;
  try {
    // 通过 ui-server 中转获取模型列表，避免 CORS
    var modelsResponse = await api('/api/proxy-models');
    var availableModels = modelsResponse.data || [];
    var modelExists = availableModels.some(function (m) { return m.id === model; });
    if (!modelExists) {
      // 不要静默替换，让用户知道并保持原选择
      toast('注意: 模型 "' + model + '" 不在代理当前模型列表中，仍将写入 Codex 配置（代理会尝试路由）', 'error');
    }
  } catch (e) {
    console.error('Failed to check models:', e);
  }

  var actualAuxModel = '';
  if (auxProvider && auxModel) {
    actualAuxModel = auxModel;
  } else {
    actualAuxModel = actualModel;
  }

  await api('/api/update-aux-model', 'POST', {
    mainModel: actualModel,
    auxModel: actualAuxModel,
    auxProvider: auxProvider || null
  });

  // Get context_window for the selected model (0 = 不配置, omit from config)
  var ctxWindow = 0;
  var allProviders = providers.providers || [];
  for (var pi = 0; pi < allProviders.length; pi++) {
    var pm = allProviders[pi].models || [];
    for (var mi = 0; mi < pm.length; mi++) {
      if (pm[mi].id === actualModel || pm[mi].slug === actualModel) {
        ctxWindow = pm[mi].context_window || 0;
        break;
      }
    }
  }

  var configBody = { model: actualModel, port: port };
  if (ctxWindow > 0) configBody.context_window = ctxWindow;
  await api('/api/codex-config', 'POST', configBody);
  currentAppliedModel = actualModel;
  currentAuxModel = actualAuxModel || actualModel;

  var allModels = [];
  (providers.providers || []).forEach(function (p) {
    (p.models || []).forEach(function (m) {
      allModels.push({ slug: m.slug || m.id, name: m.display_name || m.id, provider: p.name });
    });
  });
  updateCurrentModelDisplay(allModels);

  if (status.codex_running) {
    // Codex 已运行：停止后以相同版本重启
    toast('Codex 配置已更新，正在重启...');
    await api('/api/codex/stop', 'POST');
    await new Promise(function (r) { setTimeout(r, 500); });

    var startEndpoint = '/api/codex/start-app';
    if (status.codex_running_type) {
      switch (status.codex_running_type) {
        case 'cli': startEndpoint = '/api/codex/start-cli'; break;
        case 'codexpp': startEndpoint = '/api/codex/start-codexpp'; break;
      }
    }
    await api(startEndpoint, 'POST');
    toast('Codex 配置已更新并重启');
  } else {
    // Codex 未运行：仅写入配置，不擅自启动（无法判断用户想用哪个版本）
    toast('配置已应用到 Codex');
  }
  loadStatus();
}

// ==================== Providers ====================

async function loadProviders() {
  providers = await api('/api/providers');
  renderProviders();
  fillModelSelect();
}

function renderProviders() {
  var container = document.getElementById('provider-list');
  var list = providers.providers || [];
  if (list.length === 0) {
    container.innerHTML = '<div class="empty-state">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>' +
      '<p>暂无提供商</p>' +
      '<button class="btn btn-primary" onclick="showProviderModal()">添加第一个提供商</button>' +
    '</div>';
    return;
  }
  container.innerHTML = list.map(function (p, i) {
    return '<div class="provider-card">' +
      '<div class="provider-header">' +
        '<div class="provider-info">' +
          '<div class="provider-name-row">' +
            '<span class="provider-name">' + escHtml(p.name) + '</span>' +
            (p.name === currentDefaultProvider ? '<span class="badge badge-primary">默认</span>' : '') +
          '</div>' +
          '<div class="provider-url">' + escHtml(p.base_url) + '</div>' +
          '<div class="provider-meta">协议：' + escHtml(p.protocol || 'openai') + ' / 模型数：' + (p.models || []).length + ' / Key：' +
            (p._decrypt_warning ? '<span style="color:var(--error);" title="' + escAttr(p._decrypt_warning) + '">⚠ 需重新输入</span>' :
             p.api_key ? '●●●●●●●' : '未填写') + '</div>' +
        '</div>' +
        '<div class="provider-actions">' +
          (p._decrypt_warning ? '<span style="color:var(--warning);font-size:var(--text-xs);margin-right:var(--space-2);">⚠ 密钥已丢失，请编辑重新输入</span>' : (p.api_key ? '<button class="btn btn-sm btn-secondary" onclick="testProviderConnection(' + i + ')">测试连接</button>' : '')) +
          (p.name !== currentDefaultProvider ? '<button class="btn btn-sm btn-ghost" onclick="setDefaultProvider(\'' + escAttr(p.name) + '\')">设为默认</button>' : '') +
          '<button class="btn btn-sm btn-ghost" onclick="editProvider(' + i + ')">编辑</button>' +
          '<button class="btn btn-sm btn-ghost" onclick="deleteProvider(' + i + ')" style="color:var(--error);">删除</button>' +
        '</div>' +
      '</div>' +
      '<div class="model-tags">' +
        (p.models || []).map(function (m) {
          var ctx = m.context_window;
          var ctxLabel = ctx >= 1000000 ? Math.round(ctx / 1000000) + 'M' : ctx >= 1000 ? Math.round(ctx / 1000) + 'K' : '';
          return '<div class="model-tag-wrapper"><span class="model-tag">' + escHtml(m.display_name || m.id) +
            '<span class="remove" onclick="event.stopPropagation();removeModel(' + i + ',\'' + escAttr(m.slug || m.id) + '\')">&times;</span></span>' +
            (ctxLabel ? '<span class="model-context-hint">' + ctxLabel + ' 上下文</span>' : '') +
            '</div>';
        }).join('') +
      '</div>' +
    '</div>';
  }).join('');
}

// ---------- Provider Modal ----------

function showProviderModal(idx) {
  idx = idx !== undefined ? idx : -1;
  document.getElementById('pm-title').textContent = idx >= 0 ? '编辑提供商' : '添加提供商';
  document.getElementById('pm-idx').value = idx;
  document.getElementById('pm-fetch-status').textContent = '';
  document.getElementById('pm-fetch-status').className = 'fetch-status';
  document.getElementById('pm-model-list').style.display = 'none';
  document.getElementById('pm-model-hint').style.display = 'none';

  if (idx >= 0 && providers.providers[idx]) {
    var p = providers.providers[idx];
    document.getElementById('pm-name').value = p.name || '';
    document.getElementById('pm-base').value = p.base_url || '';
    document.getElementById('pm-key').value = p.api_key || '';
    document.getElementById('pm-protocol').value = p.protocol || 'openai';
    // Show saved models with context_window
    if (p.models && p.models.length > 0) {
      var CTX_OPTIONS = [
        { label: '8K', value: 8192 },
        { label: '16K', value: 16384 },
        { label: '32K', value: 32768 },
        { label: '64K', value: 65536 },
        { label: '128K', value: 131072 },
        { label: '200K', value: 200000 },
        { label: '500K', value: 500000 },
        { label: '1M', value: 1048576 },
        { label: '不配置', value: 0 }
      ];
      var KNOWN_CTX = {
        'mimo-v2.5': 1048576, 'mimo-v2.5-pro': 1048576,
        'deepseek-v4-pro': 1048576, 'deepseek-v4-flash': 1048576,
        'deepseek-v3': 131072, 'deepseek-r1': 131072,
        'gpt-4o': 128000, 'gpt-4o-mini': 128000,
        'gpt-4.1': 1048576, 'gpt-4.1-mini': 1048576,
        'gpt-5': 409600, 'gpt-5.2': 409600,
        'gpt-5.4': 272000, 'gpt-5.4-pro': 272000,
        'gpt-5.4-mini': 400000, 'gpt-5.4-nano': 128000,
        'o1': 200000, 'o3': 200000, 'o3-mini': 200000, 'o4-mini': 200000,
        'claude-sonnet-4-20250514': 200000, 'claude-opus-4-20250514': 200000,
        'claude-haiku-3-5': 200000,
        'gemini-2.5-pro': 1048576, 'gemini-2.5-flash': 1048576,
        'qwen3-235b': 131072, 'qwen-max': 131072,
        'mistral-large': 128000, 'llama-4-maverick': 1048576
      };
      var listEl = document.getElementById('pm-model-list');
      listEl.innerHTML = p.models.map(function (m) {
        var ctxVal = m.context_window !== undefined ? m.context_window : (KNOWN_CTX[m.id] || 0);
        var opts = CTX_OPTIONS.map(function (o) {
          return '<option value="' + o.value + '"' + (o.value === ctxVal ? ' selected' : '') + '>' + o.label + '</option>';
        }).join('');
        return '<label class="checkbox-item" style="align-items:center;">' +
          '<input type="checkbox" value="' + escAttr(m.id) + '" data-name="' + escAttr(m.display_name || m.id) + '" checked>' +
          '<span style="flex:1;">' + escHtml(m.display_name || m.id) + '</span>' +
          '<select class="model-ctx-input" data-model="' + escAttr(m.id) + '" style="width:72px;font-size:11px;padding:2px 4px;margin:0;flex:none;">' + opts + '</select>' +
        '</label>';
      }).join('');
      listEl.style.display = 'block';
      document.getElementById('pm-model-hint').style.display = 'block';
    }
  } else {
    document.getElementById('pm-name').value = '';
    document.getElementById('pm-base').value = '';
    document.getElementById('pm-key').value = '';
    document.getElementById('pm-protocol').value = 'openai';
  }
  document.getElementById('provider-modal').classList.add('show');
}

function closeProviderModal() {
  document.getElementById('provider-modal').classList.remove('show');
}

function onDefaultProviderChange() {
  var providerName = document.getElementById('env-DEFAULT_PROVIDER').value;
  var modelSelect = document.getElementById('env-DEFAULT_MODEL');
  var opts = '<option value="">（跟随请求）</option>';
  if (providerName) {
    var p = providers.providers.find(function(x) { return x.name === providerName; });
    if (p && p.models) {
      opts += p.models.map(function(m) {
        return '<option value="' + escAttr(m.id) + '">' + escHtml(m.display_name || m.id) + '</option>';
      }).join('');
    }
  }
  modelSelect.innerHTML = opts;
}

async function fetchModels() {
  var baseUrl = document.getElementById('pm-base').value.trim();
  var apiKey = document.getElementById('pm-key').value.trim();
  if (!baseUrl) { toast('请先填写 API 地址', 'error'); return; }
  if (!apiKey) { toast('请先填写 API Key', 'error'); return; }

  var btn = document.getElementById('btn-fetch');
  btn.disabled = true;
  btn.textContent = '获取中...';
  document.getElementById('pm-fetch-status').textContent = '正在请求 ' + baseUrl + '/models ...';
  document.getElementById('pm-fetch-status').className = 'fetch-status';

  try {
    var result = await api('/api/fetch-models', 'POST', { base_url: baseUrl, api_key: apiKey });
    btn.disabled = false;
    btn.textContent = '自动获取模型列表';

    if (!result.success) {
      document.getElementById('pm-fetch-status').textContent = result.error;
      document.getElementById('pm-fetch-status').className = 'fetch-status err';
      return;
    }
    var models = result.models || [];
    if (models.length === 0) {
      document.getElementById('pm-fetch-status').textContent = '未获取到模型，请检查 API 地址和 Key';
      document.getElementById('pm-fetch-status').className = 'fetch-status err';
      return;
    }

    var listEl = document.getElementById('pm-model-list');
    var KNOWN_CTX = {
      'mimo-v2.5': 1048576, 'mimo-v2.5-pro': 1048576,
      'deepseek-v4-pro': 1048576, 'deepseek-v4-flash': 1048576,
      'deepseek-v3': 131072, 'deepseek-r1': 131072,
      'gpt-4o': 128000, 'gpt-4o-mini': 128000,
      'gpt-4.1': 1048576, 'gpt-4.1-mini': 1048576,
      'gpt-5': 409600, 'gpt-5.2': 409600,
      'gpt-5.4': 272000, 'gpt-5.4-pro': 272000,
      'gpt-5.4-mini': 400000, 'gpt-5.4-nano': 128000,
      'o1': 200000, 'o3': 200000, 'o3-mini': 200000, 'o4-mini': 200000,
      'claude-sonnet-4-20250514': 200000, 'claude-opus-4-20250514': 200000,
      'claude-haiku-3-5': 200000,
      'gemini-2.5-pro': 1048576, 'gemini-2.5-flash': 1048576,
      'qwen3-235b': 131072, 'qwen-max': 131072,
      'mistral-large': 128000, 'llama-4-maverick': 1048576,
    };
    var unknownCount = 0;
    var CTX_OPTIONS = [
      { label: '不配置', value: 0 },
      { label: '8K', value: 8192 },
      { label: '16K', value: 16384 },
      { label: '32K', value: 32768 },
      { label: '64K', value: 65536 },
      { label: '128K', value: 131072 },
      { label: '200K', value: 200000 },
      { label: '500K', value: 500000 },
      { label: '1M', value: 1048576 }
    ];
    listEl.innerHTML = models.map(function (m) {
      var isKnown = KNOWN_CTX.hasOwnProperty(m.id);
      var ctxVal = KNOWN_CTX[m.id] || 0;
      if (!isKnown) unknownCount++;
      var opts = CTX_OPTIONS.map(function (o) {
        return '<option value="' + o.value + '"' + (o.value === ctxVal ? ' selected' : '') + '>' + o.label + '</option>';
      }).join('');
      var warnStyle = isKnown ? '' : 'border-color:var(--warning);';
      return '<label class="checkbox-item" style="align-items:center;' + warnStyle + '">' +
        '<input type="checkbox" value="' + escAttr(m.id) + '" data-name="' + escAttr(m.display_name || m.id) + '" checked>' +
        '<span style="flex:1;">' + escHtml(m.display_name || m.id) + (isKnown ? '' : ' <span style="color:var(--warning);font-size:10px;">请手动确认模型上下文长度</span>') + '</span>' +
        '<select class="model-ctx-input" data-model="' + escAttr(m.id) + '" style="width:72px;font-size:11px;padding:2px 4px;margin:0;flex:none;">' + opts + '</select>' +
      '</label>';
    }).join('');
    listEl.style.display = 'block';
    document.getElementById('pm-model-hint').style.display = 'block';
    var statusText = '获取到 ' + models.length + ' 个模型，勾选后保存';
    if (unknownCount > 0) {
      statusText += '。' + unknownCount + ' 个未知模型已默认"不配置"，请根据模型文档手动选择上下文长度';
    }
    document.getElementById('pm-fetch-status').textContent = statusText;
    document.getElementById('pm-fetch-status').className = 'fetch-status ok';
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '自动获取模型列表';
    document.getElementById('pm-fetch-status').textContent = '请求失败：' + e.message;
    document.getElementById('pm-fetch-status').className = 'fetch-status err';
  }
}

async function saveProvider() {
  var idx = parseInt(document.getElementById('pm-idx').value);
  var name = document.getElementById('pm-name').value.trim();
  var base_url = document.getElementById('pm-base').value.trim();
  var api_key = document.getElementById('pm-key').value.trim();
  var protocol = document.getElementById('pm-protocol').value;
  if (!name) { toast('请先填写名称', 'error'); return; }
  if (!base_url) { toast('请先填写 API 地址', 'error'); return; }

  var models = [];
  var listEl = document.getElementById('pm-model-list');
  if (listEl.style.display !== 'none') {
    listEl.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
      var ctxInput = listEl.querySelector('.model-ctx-input[data-model="' + cb.value + '"]');
      var ctxVal = ctxInput ? parseInt(ctxInput.value) || 0 : 0;
      var modelEntry = { id: cb.value, display_name: cb.dataset.name, slug: cb.value, priority: 0 };
      if (ctxVal > 0) modelEntry.context_window = ctxVal;
      models.push(modelEntry);
    });
  }
  if (idx >= 0 && models.length === 0 && providers.providers[idx]) {
    models = providers.providers[idx].models || [];
  }

  var entry = { name: name, base_url: base_url, api_key: api_key, protocol: protocol, models: models };
  if (idx >= 0) {
    providers.providers[idx] = entry;
  } else {
    providers.providers.push(entry);
  }
  await api('/api/providers', 'POST', providers);
  closeProviderModal();
  await loadProviders();

  if (providers.providers.length === 1) {
    await api('/api/env', 'PUT', { DEFAULT_PROVIDER: providers.providers[0].name });
    currentDefaultProvider = providers.providers[0].name;
  }
  toast('提供商已保存');
}

function editProvider(i) { showProviderModal(i); }

async function deleteProvider(i) {
  if (!confirm('确定删除该提供商？其下所有模型配置将一并移除。')) return;
  var deletedName = providers.providers[i] ? providers.providers[i].name : '';
  providers.providers.splice(i, 1);
  await api('/api/providers', 'POST', providers);

  if (deletedName === currentDefaultProvider) {
    var newDefault = providers.providers.length > 0 ? providers.providers[0].name : '';
    await api('/api/env', 'PUT', { DEFAULT_PROVIDER: newDefault });
    currentDefaultProvider = newDefault;
  }
  await loadProviders();
  toast('提供商已删除');
}

async function setDefaultProvider(name) {
  await api('/api/env', 'PUT', { DEFAULT_PROVIDER: name });
  currentDefaultProvider = name;
  await loadProviders();
  toast('已设置 ' + name + ' 为默认提供商，重启代理后生效');
}

async function removeModel(pi, slug) {
  if (!confirm('确定移除该模型？')) return;
  providers.providers[pi].models = (providers.providers[pi].models || []).filter(function (m) { return (m.slug || m.id) !== slug; });
  await api('/api/providers', 'POST', providers);
  await loadProviders();
  toast('模型已移除');
}

async function generateModels() {
  await api('/api/generate-models', 'POST');
  toast('user/proxy-models.json 已重新生成');
}

async function testProviderConnection(idx) {
  var p = providers.providers[idx];
  if (!p || !p.base_url || !p.api_key) { toast('请先配置 API 地址和 Key', 'error'); return; }
  toast('正在测试连接...');
  var result = await api('/api/providers/test-connection', 'POST', { base_url: p.base_url, api_key: p.api_key });
  if (result.success) {
    toast('连接成功！获取到 ' + result.model_count + ' 个模型');
  } else {
    toast('连接失败: ' + (result.error || '未知错误'), 'error');
  }
}

// ---------- Import / Export ----------

async function exportConfig() {
  if (!providers || !providers.providers || providers.providers.length === 0) {
    toast('没有可导出的配置，请先添加至少一个提供商', 'warning');
    return;
  }
  if (!confirm('配置文件将以明文形式保存，包含您的 API Key 等敏感信息。\n请妥善保管，切勿分享给不可信的第三方。\n\n确定导出？')) return;
  var d = await api('/api/export-config');
  var defaultName = 'codex-assistant-config-' + new Date().toISOString().slice(0, 10) + '.json';
  var result = await api('/api/save-file-dialog', 'POST', {
    title: '导出配置',
    content: JSON.stringify(d, null, 2),
    defaultName: defaultName,
    filter: 'JSON 文件 (*.json)|*.json'
  });
  if (result.success) {
    toast('配置已保存到: ' + result.path);
  } else if (result.message !== '未选择保存路径') {
    toast('导出失败: ' + result.message, 'error');
  }
}

function importConfig() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async function (e) {
    var file = e.target.files[0];
    if (!file) return;
    try {
      var text = await file.text();
      var data = JSON.parse(text);
      var result = await api('/api/import-config', 'POST', data);
      await loadProviders();
      if (result.needs_key_providers && result.needs_key_providers.length > 0) {
        toast('配置已导入，以下提供商需重新填写 API Key：' + result.needs_key_providers.join('、'), 'warning');
      } else {
        toast('配置已导入');
      }
    } catch (err) { toast('导入失败: ' + err.message, 'error'); }
  };
  input.click();
}

// ==================== ENV Config ====================

var ENV_CONFIG = {
  basic: [
    { key: 'PROXY_PORT', label: '代理端口', type: 'number', placeholder: '4000', desc: '代理监听端口，Codex 需连接此端口' },
    { key: 'PROXY_AUTH_KEY', label: '访问密钥', type: 'text', placeholder: '留空则不限制访问', desc: '与 Codex 通信的访问密钥。首次从 Codex 同步，修改后也会同步回 Codex，若是在 Codex 中输入了提供商的 API Key，请及时随机刷新防止泄露', hasRefresh: true, hasSync: true },
    { key: 'DEFAULT_PROVIDER', label: '默认提供商', type: 'select-provider', desc: '未指定模型时使用哪个提供商和模型' }
  ],
  advanced: [
    { key: 'UPSTREAM_TIMEOUT_MS', label: '上游超时 (ms)', type: 'number', placeholder: '120000', desc: '上游请求超时时间' },
    { key: 'STORE_TTL_MS', label: '缓存过期 (ms)', type: 'number', placeholder: '3600000', desc: '响应缓存过期时间' },
    { key: 'STORE_MAX', label: '缓存容量', type: 'number', placeholder: '500', desc: '响应缓存最大条目数' },
    { key: 'MAX_CONSECUTIVE_TOOL_CALLS', label: '最大工具调用次数', type: 'number', placeholder: '20', desc: '防止模型陷入工具调用循环' },
    { key: 'FETCH_TIMEOUT_MS', label: '请求超时 (ms)', type: 'number', placeholder: '15000', desc: 'web_fetch 单次请求超时' },
    { key: 'FETCH_MAX_BODY', label: '响应大小上限', type: 'number', placeholder: '50000', desc: 'web_fetch 响应体大小限制' },
    { key: 'MAX_FETCH_LOOPS', label: '最大嵌套层数', type: 'number', placeholder: '5', desc: 'web_fetch 最大嵌套层数' }
  ]
};

function generateRandomKey() {
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  var result = 'sk-';
  for (var i = 0; i < 32; i++) {
    result += chars.charAt(arr[i] % chars.length);
  }
  return result;
}

function refreshAuthKey() {
  // 检查是否有已加密的提供商 API Key（修改密钥会导致这些 Key 不可读）
  var encryptedCount = 0;
  (providers.providers || []).forEach(function(p) {
    if (p._decrypt_warning || (p._decrypt_error)) encryptedCount++;
  });
  
  if (encryptedCount > 0 || (providers.providers || []).length > 0) {
    var msg = '⚠ 警告：更改加密密钥将导致所有已保存的提供商 API Key 不可读！\n\n';
    if (encryptedCount > 0) {
      msg += '当前有 ' + encryptedCount + ' 个提供商的 API Key 已经无法解密。\n';
      msg += '如你持有旧密钥，可先恢复旧密钥导出配置后再更换。\n\n';
    }
    msg += '确定要继续吗？';
    if (!confirm(msg)) return;
  }
  
  var newKey = generateRandomKey();
  document.getElementById('env-PROXY_AUTH_KEY').value = newKey;
  var syncCheckbox = document.getElementById('sync-codex-key');
  if (syncCheckbox) syncCheckbox.checked = true;
  toast('已生成新密钥，保存后将同步到 Codex 配置', 'info');
}

async function loadEnv() {
  var d = await api('/api/env');
  currentDefaultProvider = (d.DEFAULT_PROVIDER || '').trim();
  window._codexApiKey = d.CODEX_API_KEY || '';
  var form = document.getElementById('env-form');

  // 不再自动生成随机密钥 — 密钥统一以 auth.json 为准
  // 用户通过「随机刷新」按钮手动生成

  function renderSection(title, items, note, collapsible) {
    var sectionId = collapsible ? 'env-section-advanced' : 'env-section-basic';
    var html = '';
    
    if (collapsible) {
      html += '<div class="collapsible-section">';
      html += '<h3 style="cursor:pointer;display:flex;align-items:center;gap:var(--space-2);margin-bottom:0;" onclick="toggleSection(\'' + sectionId + '\')">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" id="' + sectionId + '-icon" style="transition:transform 0.2s;transform:rotate(-90deg);"><polyline points="6 9 12 15 18 9"></polyline></svg>';
      html += title;
      html += '</h3>';
      if (note) html += '<div class="form-hint" style="margin-bottom:var(--space-4);margin-left:24px;">' + note + '</div>';
      html += '<div id="' + sectionId + '" style="display:none;margin-top:var(--space-4);">';
    } else {
      html += '<h3>' + title + '</h3>';
      if (note) html += '<div class="form-hint" style="margin-bottom:var(--space-4);">' + note + '</div>';
    }
    
    items.forEach(function (item) {
      var val = d[item.key] || '';
      var envKey = item.key;

      html += '<div style="margin-bottom:var(--space-4);">';
      html += '<label>' + item.label + ' <code style="font-size:10px;font-weight:400;color:var(--text-muted);">' + envKey + '</code></label>';

      if (item.type === 'select-provider') {
        var providerOpts = '<option value="">（未设置）</option>';
        providerOpts += providers.providers.map(function (p) {
          return '<option value="' + escAttr(p.name) + '"' + (p.name === currentDefaultProvider ? ' selected' : '') + '>' + escHtml(p.name) + '</option>';
        }).join('');
        var savedModel = d['DEFAULT_MODEL'] || '';
        var modelOpts = '<option value="">（跟随请求）</option>';
        if (currentDefaultProvider) {
          var cp = providers.providers.find(function(p) { return p.name === currentDefaultProvider; });
          if (cp && cp.models) {
            modelOpts += cp.models.map(function(m) {
              return '<option value="' + escAttr(m.id) + '"' + (m.id === savedModel ? ' selected' : '') + '>' + escHtml(m.display_name || m.id) + '</option>';
            }).join('');
          }
        }
        html += '<div style="display:flex;gap:var(--space-3);">';
        html += '<select id="env-DEFAULT_PROVIDER" onchange="onDefaultProviderChange()" style="flex:1;">' + providerOpts + '</select>';
        html += '<select id="env-DEFAULT_MODEL" style="flex:1;">' + modelOpts + '</select>';
        html += '</div>';
      } else if (item.hasRefresh) {
        html += '<div style="display:flex;gap:var(--space-2);"><input id="env-' + envKey + '" value="' + escAttr(val) + '" type="' + item.type + '" placeholder="' + (item.placeholder || '') + '" style="flex:1;margin-bottom:0;"><button class="btn btn-secondary" onclick="refreshAuthKey()" style="white-space:nowrap;">随机刷新</button></div>';
        if (item.hasSync) {
          html += '<div style="display:flex;align-items:center;gap:var(--space-2);margin-top:var(--space-2);"><input type="checkbox" id="sync-codex-key" checked style="width:auto;margin:0;"><label for="sync-codex-key" style="margin:0;cursor:pointer;text-transform:none;letter-spacing:0;font-size:var(--text-sm);">同步更新 Codex 密钥</label></div>';
        }
      } else {
        html += '<input id="env-' + envKey + '" value="' + escAttr(val) + '" type="' + item.type + '" placeholder="' + (item.placeholder || '') + '">';
      }

      if (item.desc) {
        html += '<div class="form-hint">' + item.desc + '</div>';
      }
      html += '</div>';
    });
    
    if (collapsible) {
      html += '</div></div>';
    }
    
    return html;
  }

  var html = renderSection('基础配置', ENV_CONFIG.basic);
  html += renderSection('高级配置', ENV_CONFIG.advanced, '以下为高级选项，一般保持默认即可', true);
  form.innerHTML = html;
}

function toggleSection(sectionId) {
  var section = document.getElementById(sectionId);
  var icon = document.getElementById(sectionId + '-icon');
  if (section.style.display === 'none') {
    section.style.display = 'block';
    if (icon) icon.style.transform = 'rotate(0deg)';
  } else {
    section.style.display = 'none';
    if (icon) icon.style.transform = 'rotate(-90deg)';
  }
}

async function saveEnv() {
  var d = {};
  var allKeys = ENV_CONFIG.basic.concat(ENV_CONFIG.advanced).map(function (i) { return i.key; });
  allKeys.forEach(function (k) {
    var el = document.getElementById('env-' + k);
    if (el) {
      var v = el.value.trim();
      if (v) d[k] = v;
    }
  });

  var syncCheckbox = document.getElementById('sync-codex-key');
  if (syncCheckbox && syncCheckbox.checked && d.PROXY_AUTH_KEY) {
    d.CODEX_API_KEY = d.PROXY_AUTH_KEY;
  }

  // Also save DEFAULT_MODEL (not in ENV_CONFIG, rendered separately)
  var modelEl = document.getElementById('env-DEFAULT_MODEL');
  if (modelEl && modelEl.value) d['DEFAULT_MODEL'] = modelEl.value;

  await api('/api/env', 'PUT', d);
  currentDefaultProvider = d['DEFAULT_PROVIDER'] || '';
  await loadProviders();
  toast('环境配置已保存，重启代理后生效');
}

async function saveEnvAndRestart() {
  await saveEnv();
  var status = await api('/api/status');
  if (status.proxy_running || status.proxy_port_alive) {
    await restartProxy();
  } else {
    toast('环境配置已保存，代理未运行，无需重启');
  }
  showPage('dashboard');
  var firstNav = document.querySelector('.nav-item');
  if (firstNav) firstNav.classList.add('active');
}

// ==================== Logs ====================

async function loadLogConfig() {
  try {
    var d = await api('/api/env');
    var level = (d.LOG_LEVEL || 'info').toLowerCase();
    var retention = d.LOG_RETENTION_DAYS || '3';
    document.getElementById('log-level').value = level;
    var retEl = document.getElementById('log-retention');
    if (retEl) retEl.value = retention;
  } catch (e) { /* transient failure, will retry */ }
}

async function saveLogConfig() {
  var level = document.getElementById('log-level').value;
  var retention = document.getElementById('log-retention').value || '3';
  var d = { LOG_LEVEL: level, LOG_RETENTION_DAYS: retention };
  await api('/api/env', 'PUT', d);
  toast('日志配置已保存，重启代理后生效');
}

async function saveLogConfigAndRestart() {
  await saveLogConfig();
  var status = await api('/api/status');
  if (status.proxy_running || status.proxy_port_alive) {
    await restartProxy();
  } else {
    toast('日志配置已保存，代理未运行，无需重启');
  }
  showPage('dashboard');
  var firstNav = document.querySelector('.nav-item');
  if (firstNav) firstNav.classList.add('active');
}

var logFilter = 'all';
var lastLogErrorAt = 0;
var logBuffer = [];
var logDiskCursor = null;
const LOG_BUFFER_MAX = 1000;

function setLogFilter(val) {
  logFilter = val;
  document.querySelectorAll('.log-filter-btn').forEach(function (b) { b.classList.remove('active'); });
  var btn = document.getElementById('log-filter-' + val);
  if (btn) btn.classList.add('active');
  loadLogs();
}

async function loadLogs() {
  try {
    var cursorParam = logDiskCursor ? '&cursor=' + encodeURIComponent(JSON.stringify(logDiskCursor)) : '';
    var d = await api('/api/logs?limit=500' + cursorParam);
    var incoming = d.logs || [];
    if (d.disk_cursor) logDiskCursor = d.disk_cursor;
    if (!logDiskCursor || d.disk_truncated || logBuffer.length === 0) {
      logBuffer = incoming;
    } else if (incoming.length > 0) {
      logBuffer = logBuffer.concat(incoming);
      if (logBuffer.length > LOG_BUFFER_MAX) logBuffer = logBuffer.slice(-LOG_BUFFER_MAX);
    }
    // Deduplicate and sort by timestamp to fix log ordering
    var seen = new Set();
    logBuffer = logBuffer.filter(function(l) {
      var key = (l.time || '') + '|' + (l.msg || '').trim().slice(0, 100);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort(function(a, b) {
      return (new Date(a.time || 0).getTime() || 0) - (new Date(b.time || 0).getTime() || 0);
    });
    var logs = logBuffer.slice(-500);
    if (logFilter !== 'all') logs = logs.filter(function (l) { return l.type === logFilter; });
    var box = document.getElementById('log-box');
    if (logs.length === 0) {
      // 区分"代理未启动"和"暂无日志"
      var statusUrl = '/api/status?t=' + Date.now();
      try {
        var st = await fetch(statusUrl).then(function(r) { return r.json(); });
        if (!st.proxy_running) {
          box.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:40px;">代理未启动，请先在仪表盘中启动代理</div>';
        } else {
          box.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:40px;">暂无日志（代理运行中，等待请求...）</div>';
        }
      } catch(e2) {
        box.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:40px;">暂无日志</div>';
      }
    } else {
      box.innerHTML = logs.map(function (l) {
        var type = String(l.type || 'info').toLowerCase();
        var cls = (type === 'error' || type === 'stderr') ? 'log-stderr' : (type === 'system' ? 'log-system' : 'log-stdout');
        return '<div class="log-entry"><span class="log-time">[' + new Date(l.time).toLocaleTimeString() + ']</span> <span class="' + cls + '">' + escHtml(l.msg) + '</span></div>';
      }).join('');
    }
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    console.warn('Failed to load proxy logs:', e);
    var now = Date.now();
    if (now - lastLogErrorAt > 30000) {
      lastLogErrorAt = now;
      var box = document.getElementById('log-box');
      if (box && (!box.innerHTML || box.textContent.indexOf('日志刷新失败') === -1)) {
        box.innerHTML = '<div style="color:var(--danger);text-align:center;padding:24px;">日志刷新失败：' + escHtml(e.message || String(e)) + '，将自动重试</div>';
      }
    }
  }
}

async function exportLogs() {
  try {
    var result = await api('/api/logs/export-content', 'GET');
    var text = (result && result.text) || '';
    if (!text.trim()) {
      toast('没有可导出的日志', 'warning');
      return;
    }
    var lineCount = result.lineCount || 0;
    var filesIncluded = result.filesIncluded || 0;
    
    // 生成默认文件名
    var now = new Date();
    var defaultName = 'codex-assistant-log-' +
      now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') + '-' +
      String(now.getMinutes()).padStart(2, '0') + '-' +
      String(now.getSeconds()).padStart(2, '0') + '.txt';
    
    // 使用 Blob 下载，浏览器会弹出保存对话框
    var blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    toast('日志导出中（共 ' + lineCount + ' 行，' + filesIncluded + ' 个文件）');
  } catch (e) {
    toast('导出日志失败: ' + e.message, 'error');
  }
}

// ==================== Update Functions ====================

var currentVersionInfo = null;

async function loadVersion() {
  try {
    currentVersionInfo = await api('/api/version');
    var versionEl = document.getElementById('current-version');
    if (versionEl && currentVersionInfo.version) {
      versionEl.textContent = 'v' + currentVersionInfo.version;
    }
  } catch (e) {
    console.error('Failed to load version:', e);
  }
}

async function checkForUpdates() {
  var btn = document.getElementById('btn-check-update');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path><polyline points="21 3 21 9 15 9"></polyline></svg>';
  }

  try {
    var data = await api('/api/check-update');
    
    if (data.hasUpdate) {
      showUpdateModal(data);
      if (btn) btn.classList.add('has-update');
    } else {
      toast('当前已是最新版本 v' + data.currentVersion);
      if (btn) btn.classList.remove('has-update');
    }
  } catch (e) {
    toast('检查更新失败: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path><polyline points="21 3 21 9 15 9"></polyline></svg> 检查版本更新';
    }
  }
}

function showUpdateModal(updateInfo) {
  // Remove existing modal if any
  var existingModal = document.getElementById('update-modal');
  if (existingModal) existingModal.remove();

  var modal = document.createElement('div');
  modal.id = 'update-modal';
  modal.className = 'modal-mask show';
  modal.innerHTML = '<div class="update-modal">' +
    '<h2>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>' +
      '发现新版本' +
    '</h2>' +
    '<div style="display:flex;gap:var(--space-4);margin-bottom:var(--space-4);">' +
      '<div style="flex:1;">' +
        '<div style="font-size:var(--text-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;">当前版本</div>' +
        '<div style="font-size:var(--text-lg);font-weight:600;">v' + escHtml(updateInfo.currentVersion) + '</div>' +
      '</div>' +
      '<div style="flex:1;">' +
        '<div style="font-size:var(--text-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;">最新版本</div>' +
        '<div style="font-size:var(--text-lg);font-weight:600;color:var(--success);">v' + escHtml(updateInfo.latestVersion) + '</div>' +
      '</div>' +
    '</div>' +
    '<div style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--space-2);">更新日志</div>' +
    '<div class="update-changelog">' + renderMarkdown(updateInfo.changelog) + '</div>' +
    '<div class="update-progress" id="update-progress" style="display:none;">' +
      '<div style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--space-1);">正在下载更新...</div>' +
      '<div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>' +
    '</div>' +
    '<div class="update-actions">' +
      '<a href="javascript:void(0)" onclick="openExternal(\'' + escAttr(updateInfo.releaseUrl) + '\')" class="btn btn-ghost">查看发布页</a>' +
      '<button class="btn btn-secondary" onclick="closeUpdateModal()">稍后更新</button>' +
      '<button class="btn btn-primary" id="btn-apply-update" onclick="applyUpdate()">立即更新</button>' +
    '</div>' +
  '</div>';

  document.body.appendChild(modal);
}

function closeUpdateModal() {
  var modal = document.getElementById('update-modal');
  if (modal) modal.remove();
}

async function applyUpdate() {
  var btn = document.getElementById('btn-apply-update');
  var progressDiv = document.getElementById('update-progress');
  var progressFill = document.getElementById('progress-fill');
  
  if (btn) {
    btn.disabled = true;
    btn.textContent = '更新中...';
  }
  if (progressDiv) progressDiv.style.display = 'block';

  try {
    var result = await api('/api/update', 'POST');
    
    if (result.success) {
      toast('更新成功！新版本: v' + result.newVersion);
      closeUpdateModal();
      
      // Update version display
      var versionEl = document.getElementById('current-version');
      if (versionEl) versionEl.textContent = 'v' + result.newVersion;
      
      // Remove update badge
      var badge = document.getElementById('btn-check-update');
      if (badge) badge.classList.remove('has-update');
      
      // Show restart prompt
      setTimeout(function() {
        if (confirm('更新已完成，需要重启代理才能生效。是否现在重启？')) {
          restartProxy();
        }
      }, 1000);
    } else {
      toast('更新失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('更新失败: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '立即更新';
    }
  }
}

// ==================== Settings ====================

var CLOSE_BEHAVIOR_KEY = 'codex-assistant-close-behavior';

function loadCloseBehavior() {
  var saved = localStorage.getItem(CLOSE_BEHAVIOR_KEY);
  var behavior = saved !== null ? parseInt(saved) : 1; // default: minimize to tray
  var radios = document.querySelectorAll('input[name="close-behavior"]');
  radios.forEach(function (r) {
    r.checked = parseInt(r.value) === behavior;
  });
  // Tell Rust the current behavior
  if (window.__TAURI__ && window.__TAURI__.core) {
    window.__TAURI__.core.invoke('set_close_behavior', { behavior: behavior });
  }
}

function setCloseBehavior(value) {
  localStorage.setItem(CLOSE_BEHAVIOR_KEY, String(value));
  // Tell Rust the new behavior
  if (window.__TAURI__ && window.__TAURI__.core) {
    window.__TAURI__.core.invoke('set_close_behavior', { behavior: value });
  }
  var labels = { 0: '直接关闭', 1: '最小化到托盘', 2: '每次询问' };
  toast('关闭行为已设置为：' + labels[value]);
}

// ==================== Close Confirmation Dialog ====================

function showCloseConfirmDialog() {
  // 创建确认对话框
  var mask = document.createElement('div');
  mask.className = 'modal-mask show';
  mask.style.zIndex = '10001';
  mask.innerHTML = '<div class="modal" style="width:400px;">' +
    '<h2>关闭窗口</h2>' +
    '<p style="margin-bottom:var(--space-5);color:var(--text-secondary);">请选择如何处理窗口：</p>' +
    '<div class="modal-btns" style="flex-direction:column;gap:var(--space-2);">' +
    '<button class="btn btn-primary" style="width:100%;" onclick="confirmCloseAction(\'minimize\')">最小化到托盘</button>' +
    '<button class="btn btn-danger" style="width:100%;" onclick="confirmCloseAction(\'exit\')">直接退出程序</button>' +
    '<button class="btn btn-secondary" style="width:100%;" onclick="confirmCloseAction(\'cancel\')">取消</button>' +
    '</div></div>';
  document.body.appendChild(mask);
}

function confirmCloseAction(action) {
  // 关闭对话框
  var masks = document.querySelectorAll('.modal-mask');
  masks.forEach(function(m) {
    if (m.style.zIndex === '10001') {
      m.remove();
    }
  });

  if (action === 'minimize') {
    // 最小化到托盘
    if (window.__TAURI__ && window.__TAURI__.core) {
      window.__TAURI__.core.invoke('minimize_to_tray');
    }
  } else if (action === 'exit') {
    // 直接退出
    if (window.__TAURI__ && window.__TAURI__.core) {
      window.__TAURI__.core.invoke('force_close');
    }
  }
  // cancel: 什么都不做
}

// 监听 Rust 发来的关闭请求事件
async function setupCloseEventListener() {
  try {
    // Tauri v2 API
    if (window.__TAURI__ && window.__TAURI__.event) {
      await window.__TAURI__.event.listen('close-requested', function(event) {
        console.log('[close] Received close-requested event', event);
        showCloseConfirmDialog();
      });
      console.log('[close] Event listener registered');
    } else {
      console.warn('[close] Tauri event API not available');
    }
  } catch (e) {
    console.error('[close] Failed to setup event listener:', e);
  }
}

// ==================== Init ====================

(async function () {
  initCsrfToken();
  applyTheme();
  updateThemeRadioUI();
  setupCloseEventListener();
  await loadVersion();
  await loadStatus();
  await loadEnv();
  await loadProviders();
  await checkCodexInstalled();
  loadCloseBehavior();

  // Load current Codex config model
  try {
    var codexConfig = await api('/api/codex-config');
    if (codexConfig.parsed && codexConfig.parsed.model) {
      currentAppliedModel = codexConfig.parsed.model;
    }
  } catch (e) { /* transient failure, will retry */ }

  // Load aux model config
  try {
    var auxConfig = await api('/api/get-aux-model');
    if (auxConfig.auxModel) {
      currentAuxModel = auxConfig.auxModel;
    } else {
      currentAuxModel = currentAppliedModel;
    }
  } catch (e) {
    currentAuxModel = currentAppliedModel;
  }

  // Update model display
  var allModels = [];
  (providers.providers || []).forEach(function (p) {
    (p.models || []).forEach(function (m) {
      allModels.push({ slug: m.slug || m.id, name: m.display_name || m.id, provider: p.name });
    });
  });
  updateCurrentModelDisplay(allModels);

  applyTheme();
  startStatusLoop();
  startUptimeTicker();

  // Auto-refresh logs when on logs page
  setInterval(function () {
    if (document.getElementById('page-logs') && document.getElementById('page-logs').classList.contains('active')) {
      loadLogs();
    }
  }, 15000);
})();
