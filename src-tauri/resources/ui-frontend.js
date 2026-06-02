// ============================================================
// Codex Assistant — UI Controller
// ============================================================

// ---------- State ----------
let providers = { providers: [] };
let statusTimer = null;
let currentDefaultProvider = '';
let currentTheme = localStorage.getItem('codex-assistant-theme') || 'light';

// ---------- Theme ----------
function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.body.className = currentTheme === 'light' ? 'theme-light' : '';
  localStorage.setItem('codex-assistant-theme', currentTheme);
  updateThemeUI();
}

function updateThemeUI() {
  const btn = document.getElementById('btn-theme');
  const icon = document.getElementById('icon-theme');
  if (!btn || !icon) return;

  if (currentTheme === 'dark') {
    btn.querySelector('span').textContent = '浅色模式';
    icon.innerHTML = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
  } else {
    btn.querySelector('span').textContent = '深色模式';
    icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
  }
}

function applyTheme() {
  if (currentTheme === 'light') {
    document.body.className = 'theme-light';
  } else {
    document.body.className = '';
  }
  updateThemeUI();
}

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
  if (id === 'env') { loadEnv(); loadCodexppConfig(); }
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
          toast('代理异常退出，请查看运行日志', 'error');
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
      displayEl.innerHTML = '<div class="model-display-value" style="color:var(--text-muted);">请配置codex的供应商和模型信息并应用</div>';
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
    setTimeout(loadStatus, 1500);
    return;
  }
  
  // Check if any providers are configured
  var pd = await api('/api/providers');
  var providerCount = (pd.providers || []).length;
  if (providerCount === 0) {
    toast('请先在"提供商管理"中添加至少一个模型供应商', 'error');
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
    // 双重刷新确保状态同步
    setTimeout(loadStatus, 2000);
    setTimeout(loadStatus, 4000);
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
  var status = await api('/api/status');
  if (!status.proxy_running) {
    toast('代理未运行，正在启动代理...');
    var proxyResult = await api('/api/proxy/start', 'POST');
    if (proxyResult.success) {
      toast('代理已启动');
      await new Promise(function (r) { setTimeout(r, 2000); });
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
  setTimeout(loadStatus, 2000);
}

async function stopCodex() {
  await api('/api/codex/stop', 'POST');
  toast('Codex 已停止');
  loadStatus();
}

async function checkCodexInstalled() {
  try {
    var result = await api('/api/codex/check-installed');
    var btnMap = {
      'cli': 'btn-codex-cli',
      'app': 'btn-codex-app',
      'codexpp': 'btn-codexpp',
      'codexpp-manager': 'btn-codexpp-manager'
    };
    Object.keys(btnMap).forEach(function (m) {
      var btn = document.getElementById(btnMap[m]);
      if (!btn) return;

      var installed = false;
      if (m === 'cli' || m === 'app') installed = result.codex;
      else if (m === 'codexpp') installed = result.codexPlusPlus;
      else if (m === 'codexpp-manager') installed = result.codexPlusPlusManager;

      btn.disabled = !installed;
      if (m === 'app' && result.codex) {
        var codexType = result.codexType || 'exe';
        btn.textContent = '启动 Codex 桌面版' + (codexType === 'store' ? ' (商店)' : '');
        btn.title = result.codex ? '启动 Codex 桌面版' : '未安装 Codex';
      }
    });
  } catch (e) {
    console.error('Failed to check Codex installed:', e);
  }
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
  var result = await api('/api/codexpp-path', 'POST', { codexppPath: codexppPath, codexppMgrPath: mgrPath });
  if (result && result.success) {
    toast('Codex++ 路径已保存');
    await checkCodexInstalled();
  } else {
    toast((result && result.error) || '保存失败', 'error');
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
      await new Promise(function (r) { setTimeout(r, 2000); });
    } else {
      toast('代理启动失败: ' + (proxyResult.message || '未知错误'), 'error');
      return;
    }
  }

  var actualModel = model;
  try {
    var env = status.env || {};
    var proxyPort = env.PROXY_PORT || '4000';
    var modelsResponse = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models');
    var modelsData = await modelsResponse.json();
    var availableModels = modelsData.data || [];
    var modelExists = availableModels.some(function (m) { return m.id === model; });
    if (!modelExists) {
      actualModel = availableModels.length > 0 ? availableModels[0].id : model;
      toast('模型 "' + model + '" 未在代理中配置，已切换为: ' + actualModel, 'error');
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

  // Get context_window for the selected model
  var ctxWindow = 131072;
  var allProviders = providers.providers || [];
  for (var pi = 0; pi < allProviders.length; pi++) {
    var pm = allProviders[pi].models || [];
    for (var mi = 0; mi < pm.length; mi++) {
      if (pm[mi].id === actualModel || pm[mi].slug === actualModel) {
        ctxWindow = pm[mi].context_window || 131072;
        break;
      }
    }
  }

  await api('/api/codex-config', 'POST', { model: actualModel, port: port, context_window: ctxWindow });
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
    await new Promise(function (r) { setTimeout(r, 1500); });

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
          '<div class="provider-meta">协议：' + escHtml(p.protocol || 'openai') + ' / 模型数：' + (p.models || []).length + ' / Key：' + (p.api_key ? '●●●●●●●' : '未填写') + '</div>' +
        '</div>' +
        '<div class="provider-actions">' +
          (p.api_key ? '<button class="btn btn-sm btn-secondary" onclick="testProviderConnection(' + i + ')">测试连接</button>' : '') +
          (p.name !== currentDefaultProvider ? '<button class="btn btn-sm btn-ghost" onclick="setDefaultProvider(\'' + escAttr(p.name) + '\')">设为默认</button>' : '') +
          '<button class="btn btn-sm btn-ghost" onclick="editProvider(' + i + ')">编辑</button>' +
          '<button class="btn btn-sm btn-ghost" onclick="deleteProvider(' + i + ')" style="color:var(--error);">删除</button>' +
        '</div>' +
      '</div>' +
      '<div class="model-tags">' +
        (p.models || []).map(function (m) {
          var ctx = m.context_window;
          var ctxLabel = ctx ? (ctx >= 1000000 ? (ctx / 1000000) + 'M' : (ctx / 1000) + 'K') : '';
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
      var KNOWN_CTX = { 'mimo-v2.5': 1048576, 'mimo-v2.5-pro': 1048576, 'deepseek-v4-pro': 131072, 'deepseek-v4-flash': 131072, 'deepseek-v3': 131072, 'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'o1': 200000, 'o3-mini': 200000, 'claude-sonnet-4-20250514': 200000 };
      var listEl = document.getElementById('pm-model-list');
      listEl.innerHTML = p.models.map(function (m) {
        var ctx = m.context_window || KNOWN_CTX[m.id] || 131072;
        return '<label class="checkbox-item" style="align-items:center;">' +
          '<input type="checkbox" value="' + escAttr(m.id) + '" data-name="' + escAttr(m.display_name || m.id) + '" checked>' +
          '<span style="flex:1;">' + escHtml(m.display_name || m.id) + '</span>' +
          '<input type="number" class="model-ctx-input" data-model="' + escAttr(m.id) + '" value="' + ctx + '" title="上下文窗口 (tokens)" style="width:90px;font-size:11px;padding:2px 6px;margin:0;flex:none;">' +
          '<span style="color:var(--text-muted);font-size:10px;flex:none;">tokens</span>' +
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
    var KNOWN_CTX = { 'mimo-v2.5': 1048576, 'mimo-v2.5-pro': 1048576, 'deepseek-v4-pro': 131072, 'deepseek-v4-flash': 131072, 'deepseek-v3': 131072, 'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'o1': 200000, 'o3-mini': 200000, 'claude-sonnet-4-20250514': 200000 };
    listEl.innerHTML = models.map(function (m) {
      var ctx = KNOWN_CTX[m.id] || 131072;
      return '<label class="checkbox-item" style="align-items:center;">' +
        '<input type="checkbox" value="' + escAttr(m.id) + '" data-name="' + escAttr(m.display_name || m.id) + '" checked>' +
        '<span style="flex:1;">' + escHtml(m.display_name || m.id) + '</span>' +
        '<input type="number" class="model-ctx-input" data-model="' + escAttr(m.id) + '" value="' + ctx + '" title="上下文窗口 (tokens)" style="width:90px;font-size:11px;padding:2px 6px;margin:0;flex:none;">' +
        '<span style="color:var(--text-muted);font-size:10px;flex:none;">tokens</span>' +
      '</label>';
    }).join('');
    listEl.style.display = 'block';
    document.getElementById('pm-model-hint').style.display = 'block';
    document.getElementById('pm-fetch-status').textContent = '获取到 ' + models.length + ' 个模型，勾选后保存';
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
  if (!name) { toast('请填写名称', 'error'); return; }
  if (!base_url) { toast('请填写 API 地址', 'error'); return; }

  var models = [];
  var listEl = document.getElementById('pm-model-list');
  if (listEl.style.display !== 'none') {
    listEl.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
      var ctxInput = listEl.querySelector('.model-ctx-input[data-model="' + cb.value + '"]');
      var ctxVal = ctxInput ? parseInt(ctxInput.value) || 131072 : 131072;
      models.push({ id: cb.value, display_name: cb.dataset.name, slug: cb.value, priority: 0, context_window: ctxVal });
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
  if (!confirm('确定删除该提供商及其所有模型？')) return;
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
  var result = await api('/api/save-file', 'POST', {
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
    { key: 'PROXY_AUTH_KEY', label: '访问密钥', type: 'text', placeholder: '留空则不限制访问', desc: '代理访问密钥，Codex 需填写相同密钥', hasRefresh: true, hasSync: true },
    { key: 'DEFAULT_PROVIDER', label: '默认提供商', type: 'select-provider', desc: '未指定模型时使用哪个提供商和模型' }
  ],
  advanced: [
    { key: 'UPSTREAM_TIMEOUT_MS', label: '上游超时 (ms)', type: 'number', placeholder: '120000', desc: '上游请求超时时间' },
    { key: 'STORE_TTL_MS', label: '缓存过期 (ms)', type: 'number', placeholder: '3600000', desc: '响应缓存过期时间' },
    { key: 'STORE_MAX', label: '缓存容量', type: 'number', placeholder: '500', desc: '响应缓存最大条目数' },
    { key: 'MAX_CONSECUTIVE_TOOL_CALLS', label: '工具调用上限', type: 'number', placeholder: '20', desc: '防止工具调用死循环' },
    { key: 'FETCH_TIMEOUT_MS', label: '抓取超时 (ms)', type: 'number', placeholder: '15000', desc: 'web_fetch 单次请求超时' },
    { key: 'FETCH_MAX_BODY', label: '抓取上限 (bytes)', type: 'number', placeholder: '50000', desc: 'web_fetch 响应体大小限制' },
    { key: 'MAX_FETCH_LOOPS', label: '抓取循环上限', type: 'number', placeholder: '5', desc: 'web_fetch 最大嵌套层数' }
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
  var newKey = generateRandomKey();
  document.getElementById('env-PROXY_AUTH_KEY').value = newKey;
  var syncCheckbox = document.getElementById('sync-codex-key');
  if (syncCheckbox) syncCheckbox.checked = true;
  toast('已生成新密钥，记得保存配置');
}

async function loadEnv() {
  var d = await api('/api/env');
  currentDefaultProvider = (d.DEFAULT_PROVIDER || '').trim();
  window._codexApiKey = d.CODEX_API_KEY || '';
  var form = document.getElementById('env-form');

  // 首次访问自动生成随机密钥
  if (!d.PROXY_AUTH_KEY) {
    var newKey = generateRandomKey();
    d.PROXY_AUTH_KEY = newKey;
    await api('/api/env', 'PUT', { PROXY_AUTH_KEY: newKey, CODEX_API_KEY: newKey });
    toast('已自动生成访问密钥');
  }

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
  html += renderSection('高级配置', ENV_CONFIG.advanced, '通常无需修改，除非你明确知道自己在做什么', true);
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

function setLogFilter(val) {
  logFilter = val;
  document.querySelectorAll('.log-filter-btn').forEach(function (b) { b.classList.remove('active'); });
  var btn = document.getElementById('log-filter-' + val);
  if (btn) btn.classList.add('active');
  loadLogs();
}

async function loadLogs() {
  try {
    var d = await api('/api/logs');
    var logs = d.logs || [];
    if (logFilter !== 'all') logs = logs.filter(function (l) { return l.type === logFilter; });
    var box = document.getElementById('log-box');
    if (logs.length === 0) {
      box.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:40px;">暂无日志</div>';
    } else {
      box.innerHTML = logs.map(function (l) {
        var cls = l.type === 'stdout' ? 'log-stdout' : l.type === 'stderr' ? 'log-stderr' : 'log-system';
        return '<div class="log-entry"><span class="log-time">[' + new Date(l.time).toLocaleTimeString() + ']</span> <span class="' + cls + '">' + escHtml(l.msg) + '</span></div>';
      }).join('');
    }
    box.scrollTop = box.scrollHeight;
  } catch (e) { /* transient failure, will retry */ }
}

async function exportLogs() {
  var text = document.getElementById('log-box').textContent;
  var defaultName = 'codex-assistant-log-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.txt';
  var result = await api('/api/save-file', 'POST', {
    title: '导出日志',
    content: text,
    defaultName: defaultName,
    filter: '文本文件 (*.txt)|*.txt|所有文件 (*.*)|*.*'
  });
  if (result.success) {
    toast('日志已保存到: ' + result.path);
  } else if (result.message !== '未选择保存路径') {
    toast('导出失败: ' + result.message, 'error');
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

// ==================== Init ====================

(async function () {
  initCsrfToken();
  applyTheme();
  await loadVersion();
  await loadStatus();
  await loadEnv();
  await loadProviders();
  await checkCodexInstalled();

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
