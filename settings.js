// Dependencies: common.js, dashboard.js, providers.js, env.js, backup.js
// ==================== Update Functions ====================

var currentVersionInfo = null;

// WebView2 compatibility check for Win11
function checkTauriCompat() {
  if (window.__TAURI__ && window.__TAURI__.core) return { ok: true };
  if (window.location.protocol === 'tauri:' || window.location.hostname === 'tauri.localhost') {
    return { ok: false, reason: 'Tauri API 未加载，请更新 WebView2 Runtime' };
  }
  return { ok: true }; // browser mode, no Tauri needed
}

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

// Simple semver comparison (duplicated from server for frontend fallback)
function _compareVersions(v1, v2) {
  var p1 = v1.split('.').map(Number);
  var p2 = v2.split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    if ((p1[i] || 0) < (p2[i] || 0)) return -1;
    if ((p1[i] || 0) > (p2[i] || 0)) return 1;
  }
  return 0;
}

// Try GitHub API from browser (respects system proxy / hosts)
async function _checkUpdateFromBrowser() {
  var GITHUB_API = 'https://api.github.com/repos/muyun1314/codex-assistant/releases/latest';
  try {
    var res = await fetch(GITHUB_API, {
      headers: { 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!res.ok) return { error: 'GitHub API 返回 HTTP ' + res.status };
    var release = await res.json();
    var latestVersion = (release.tag_name || '').replace(/^v/, '');
    if (!latestVersion) return { error: '无法解析版本号' };

    return {
      hasUpdate: _compareVersions(currentVersionInfo.version || '0', latestVersion) < 0,
      currentVersion: currentVersionInfo.version,
      latestVersion: latestVersion,
      changelog: release.body || '',
      releaseUrl: release.html_url || ('https://github.com/muyun1314/codex-assistant/releases/tag/' + release.tag_name),
      _source: 'browser-direct'
    };
  } catch (e) {
    return { error: '浏览器请求也失败：' + (e.message || '未知错误') };
  }
}

async function checkForUpdates() {
  var btn = document.getElementById('btn-check-update');
  // If update already detected, clicking opens settings page
  if (_pendingUpdate && _pendingUpdate.hasUpdate) {
    showPage('settings');
    setTimeout(function() {
      var el = document.getElementById('settings-update-area');
      if (el) el.scrollIntoView({behavior: 'smooth'});
    }, 200);
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path><polyline points="21 3 21 9 15 9"></polyline></svg> 检查中...';
  }

  try {
    var data = await api('/api/check-update');
    _handleCheckResult(data, btn);
  } catch (e) {
    console.log('[ui] Server check failed, trying browser...');
    var browserResult = await _checkUpdateFromBrowser();
    _handleCheckResult(browserResult, btn);
  }
}

function _handleCheckResult(data, btn) {
  if (data.hasUpdate) {
    _pendingUpdate = data;
    _setUpdateBtn('hasUpdate', data.latestVersion);
    showUpdateModal(data);
  } else if (data.checkError || data.error) {
    toast('检查更新失败：' + (data.checkError || data.error), 'error');
    _setUpdateBtn('default');
  } else {
    toast('当前已是最新版本 v' + (data.currentVersion || '?'));
    _setUpdateBtn('default');
  }
}

// ====== Update Button ======
var _pendingUpdate = null;

function _setUpdateBtn(state, extra) {
  var btn = document.getElementById('btn-check-update');
  if (!btn) return;
  btn.disabled = false;

  if (state === 'hasUpdate') {
    btn.innerHTML = '当前有新版本，立即下载';
    btn.className = 'btn btn-xs btn-ghost update-badge has-update';
    btn.title = '点击跳转到设置下载更新';
    _syncSettingsStatus();
  } else {
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path><polyline points="21 3 21 9 15 9"></polyline></svg> 检查版本更新';
    btn.className = 'btn btn-xs btn-ghost update-badge';
    btn.title = '检查版本更新';
    _syncSettingsStatus();
  }
}

// ====== Update Modal ======
function showUpdateModal(updateInfo) {
  _pendingUpdate = updateInfo;
  var existingModal = document.getElementById('update-modal');
  if (existingModal) existingModal.remove();

  var modal = document.createElement('div');
  modal.id = 'update-modal';
  modal.className = 'modal-mask show';
  modal.innerHTML = '<div class="update-modal">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">' +
      '<h2 style="margin:0;display:flex;align-items:center;gap:var(--space-2);">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>' +
        '发现新版本' +
      '</h2>' +
      '<button class="btn btn-ghost btn-xs" onclick="closeUpdateModal()" style="font-size:18px;line-height:1;padding:0 4px;" title="关闭">&times;</button>' +
    '</div>' +
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
    '<div class="update-actions">' +
      '<a href="javascript:void(0)" onclick="openExternal(\'' + escAttr(updateInfo.releaseUrl) + '\')" class="btn btn-ghost">查看发布页</a>' +
      '<button class="btn btn-secondary" onclick="closeUpdateModal()">稍后</button>' +
      '<button class="btn btn-primary" onclick="closeUpdateModal();showPage(\'settings\');setTimeout(function(){var el=document.getElementById(\'settings-update-area\');if(el)el.scrollIntoView({behavior:\'smooth\'});},200);">立即下载</button>' +
    '</div>' +
  '</div>';

  document.body.appendChild(modal);
}

function closeUpdateModal() {
  var modal = document.getElementById('update-modal');
  if (modal) modal.remove();
}

// ====== Changelog-only modal (from settings "更新日志" button) ======
function showChangelogModal() {
  if (!_pendingUpdate || !_pendingUpdate.changelog) {
    toast('暂无更新日志');
    return;
  }
  var existingModal = document.getElementById('update-modal');
  if (existingModal) existingModal.remove();

  var modal = document.createElement('div');
  modal.id = 'update-modal';
  modal.className = 'modal-mask show';
  modal.innerHTML = '<div class="update-modal">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">' +
      '<h2 style="margin:0;">更新日志</h2>' +
      '<button class="btn btn-ghost btn-xs" onclick="closeUpdateModal()" style="font-size:18px;line-height:1;padding:0 4px;" title="关闭">&times;</button>' +
    '</div>' +
    '<div class="update-changelog">' + renderMarkdown(_pendingUpdate.changelog) + '</div>' +
    '<div class="update-actions">' +
      '<button class="btn btn-primary" onclick="closeUpdateModal()">关闭</button>' +
    '</div>' +
  '</div>';
  document.body.appendChild(modal);
}

function _syncSettingsStatus() {
  var el = document.getElementById('settings-update-status');
  var logBtn = document.getElementById('btn-changelog');
  if (!el) return;
  if (_pendingUpdate && _pendingUpdate.hasUpdate) {
    el.textContent = '有新版本 v' + _pendingUpdate.latestVersion + ' 可用';
    el.className = 'update-status-text has-update';
    if (logBtn) logBtn.style.display = '';
  } else {
    el.textContent = '当前已是最新版本';
    el.className = 'update-status-text';
    if (logBtn) logBtn.style.display = 'none';
  }
}

// Auto-check after startup
function _autoCheckOnStartup(delayMs) {
  setTimeout(function() {
    _checkUpdateFromBrowser().then(function(result) {
      if (result.hasUpdate) {
        _pendingUpdate = result;
        _setUpdateBtn('hasUpdate', result.latestVersion);
        _syncSettingsStatus();
      }
    }).catch(function(e) {
      console.log('[ui] Auto-check failed:', e.message);
    });
  }, delayMs || 8000);
}

// ==================== Settings ====================

var CLOSE_BEHAVIOR_KEY = 'codex-assistant-close-behavior';

function loadCloseBehavior() {
  var saved = localStorage.getItem(CLOSE_BEHAVIOR_KEY);
  var behavior = saved !== null ? parseInt(saved) : 1;
  var radios = document.querySelectorAll('input[name="close-behavior"]');
  radios.forEach(function (r) {
    r.checked = parseInt(r.value) === behavior;
  });
  if (window.__TAURI__ && window.__TAURI__.core) {
    window.__TAURI__.core.invoke('set_close_behavior', { behavior: behavior });
  }
}

function setCloseBehavior(value) {
  localStorage.setItem(CLOSE_BEHAVIOR_KEY, String(value));
  if (window.__TAURI__ && window.__TAURI__.core) {
    window.__TAURI__.core.invoke('set_close_behavior', { behavior: value });
  }
  var labels = { 0: '直接关闭', 1: '最小化到托盘', 2: '每次询问' };
  toast('关闭行为已设置为：' + labels[value]);
}

// ==================== Close Confirmation Dialog ====================

function showCloseConfirmDialog() {
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
    '</div>' +
    '<label class="checkbox-item" style="margin-top:var(--space-4);justify-content:center;cursor:pointer;">' +
    '<input type="checkbox" id="chk-remember-close">' +
    '<span style="font-size:var(--text-sm);color:var(--text-secondary);">记住我的选择，下次不再询问</span>' +
    '</label></div>';
  document.body.appendChild(mask);
}

function confirmCloseAction(action) {
  var chk = document.getElementById('chk-remember-close');
  if (chk && chk.checked) {
    if (action === 'minimize') {
      setCloseBehavior(1);
    } else if (action === 'exit') {
      setCloseBehavior(0);
    }
  }

  var masks = document.querySelectorAll('.modal-mask');
  masks.forEach(function(m) {
    if (m.style.zIndex === '10001') m.remove();
  });
  if (action === 'minimize') {
    if (window.__TAURI__ && window.__TAURI__.core) window.__TAURI__.core.invoke('minimize_to_tray');
  } else if (action === 'exit') {
    if (window.__TAURI__ && window.__TAURI__.core) window.__TAURI__.core.invoke('force_close');
  }
}

async function setupCloseEventListener() {
  try {
    if (window.__TAURI__ && window.__TAURI__.event) {
      await window.__TAURI__.event.listen('close-requested', function(event) {
        var saved = localStorage.getItem(CLOSE_BEHAVIOR_KEY);
        if (saved !== null) {
          var behavior = parseInt(saved);
          if (behavior === 1) {
            if (window.__TAURI__ && window.__TAURI__.core) window.__TAURI__.core.invoke('minimize_to_tray');
            return;
          } else if (behavior === 0) {
            if (window.__TAURI__ && window.__TAURI__.core) window.__TAURI__.core.invoke('force_close');
            return;
          }
        }
        showCloseConfirmDialog();
      });
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

  try {
    var codexConfig = await api('/api/codex-config');
    if (codexConfig.parsed && codexConfig.parsed.model) {
      currentAppliedModel = codexConfig.parsed.model;
    }
  } catch (e) {}

  try {
    var auxConfig = await api('/api/get-aux-model');
    if (auxConfig.auxModel) { currentAuxModel = auxConfig.auxModel; }
    else { currentAuxModel = currentAppliedModel; }
  } catch (e) { currentAuxModel = currentAppliedModel; }

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

  _autoCheckOnStartup(8000);

  setInterval(function () {
    if (document.getElementById('page-logs') && document.getElementById('page-logs').classList.contains('active')) {
      loadLogs();
    }
  }, 15000);
})();
