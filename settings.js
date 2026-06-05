// ============================================================
// Codex Assistant — Settings (version, updates, close behavior, init)
// ============================================================

// ---------- Version & Updates ----------

async function loadVersion() {
  try {
    var v = await api('/api/version');
    var versionEl = document.getElementById('current-version');
    if (versionEl) versionEl.textContent = 'v' + v.version;
    var channelEl = document.getElementById('update-channel');
    if (channelEl) channelEl.textContent = v.updateChannel || 'stable';

    // Check for updates silently
    if (v.hasUpdate) {
      var badge = document.getElementById('btn-check-update');
      if (badge) badge.classList.add('has-update');
    }
  } catch (e) {
    console.error('[ui] Failed to load version:', e);
  }
}

async function checkForUpdates() {
  var btn = document.getElementById('btn-check-update');
  if (btn) {
    btn.textContent = '检查中...';
    btn.disabled = true;
  }
  try {
    var result = await api('/api/check-update');
    if (result.hasUpdate) {
      showUpdateModal(result);
    } else {
      toast('已是最新版本 ✓');
    }
  } catch (e) {
    toast('检查更新失败: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.textContent = '检查更新';
      btn.disabled = false;
      btn.classList.remove('has-update');
    }
  }
}

function showUpdateModal(updateInfo) {
  var existing = document.getElementById('update-modal');
  if (existing) existing.remove();

  var modal = document.createElement('div');
  modal.id = 'update-modal';
  modal.className = 'modal-mask show';
  modal.style.zIndex = '10000';

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

// ==================== Close Behavior ====================

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
