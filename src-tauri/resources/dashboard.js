// Dependencies: common.js
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

  var auxText = mainName;
  var auxColor = mainColor;
  if (currentAuxModel && currentAuxModel !== currentAppliedModel) {
    var auxModel = allModels.find(function (m) { return m.slug === currentAuxModel; });
    if (auxModel) {
      auxText = auxModel.name;
      auxColor = 'var(--accent)';
    }
    // Not found in models list (alias like gpt-5.4) → show main model name
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

// ==================== Context Trim Toggle ====================

function formatTokenCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function estimateTokenSavings() {
  var trimEnabled = document.getElementById('trim-toggle-btn');
  var savingBox = document.getElementById('trim-saving-inline');
  var savingValue = document.getElementById('trim-saving-value');
  if (!savingBox || !savingValue) return;

  if (!trimEnabled || !trimEnabled.classList.contains('on')) {
    savingBox.style.display = 'flex';
    savingValue.textContent = '0';
    return;
  }

  api('/api/proxy-stats', 'GET')
    .then(function(stats) {
      var ts = (stats && stats.trim_stats) ? stats.trim_stats : {};
      var tokensSaved = ts.estimatedTokensSaved || (ts.totalTrimmed || 0) * 800;

      savingBox.style.display = 'flex';
      savingValue.textContent = formatTokenCount(tokensSaved);
    })
    .catch(function() {
      savingBox.style.display = 'flex';
      savingValue.textContent = '--';
    });
}

// 每 5 秒刷新一次节省数据
setInterval(function() {
  var trimEnabled = document.getElementById('trim-toggle-btn');
  if (trimEnabled && trimEnabled.classList.contains('on')) {
    estimateTokenSavings();
  }
}, 5000);

function loadTrimConfig() {
  api('/api/trim-config', 'GET')
    .then(function(config) {
      var btn = document.getElementById('trim-toggle-btn');
      var statusText = document.getElementById('trim-status-text');
      var label = document.getElementById('trim-toggle-label');

      if (!btn || !statusText) return;

      if (config.enabled) {
        btn.classList.add('on');
        statusText.textContent = '已启用 — 自动裁剪旧的工具调用日志，保持上下文精简';
        statusText.style.color = 'var(--success)';
        if (label) label.textContent = 'ON';
      } else {
        btn.classList.remove('on');
        statusText.textContent = '未启用 — 完整保留所有历史消息';
        statusText.style.color = 'var(--text-muted)';
        if (label) label.textContent = 'OFF';
      }

      estimateTokenSavings();
    })
    .catch(function() {});
}

function onTrimToggle() {
  var btn = document.getElementById('trim-toggle-btn');
  if (!btn) return;

  var currentlyOn = btn.classList.contains('on');
  var newEnabled = !currentlyOn;

  // 先切换 UI
  var statusText = document.getElementById('trim-status-text');
  var label = document.getElementById('trim-toggle-label');

  if (newEnabled) {
    btn.classList.add('on');
    if (statusText) { statusText.textContent = '已启用 — 自动裁剪旧的工具调用日志，保持上下文精简'; statusText.style.color = 'var(--success)'; }
    if (label) label.textContent = 'ON';
  } else {
    btn.classList.remove('on');
    if (statusText) { statusText.textContent = '未启用 — 完整保留所有历史消息'; statusText.style.color = 'var(--text-muted)'; }
    if (label) label.textContent = 'OFF';
  }

  api('/api/trim-config', 'POST', { enabled: newEnabled, keepToolRounds: 20 })
    .then(function(result) {
      if (result.success) {
        toast(newEnabled ? '上下文裁剪已开启，代理下次请求时立即生效' : '上下文裁剪已关闭', 'success');
        estimateTokenSavings();
      } else {
        throw new Error('save failed');
      }
    })
    .catch(function() {
      // 失败回滚：恢复之前的状态
      if (currentlyOn) {
        btn.classList.add('on');
        if (statusText) { statusText.textContent = '已启用 — 自动裁剪旧的工具调用日志，保持上下文精简'; statusText.style.color = 'var(--success)'; }
        if (label) label.textContent = 'ON';
      } else {
        btn.classList.remove('on');
        if (statusText) { statusText.textContent = '未启用 — 完整保留所有历史消息'; statusText.style.color = 'var(--text-muted)'; }
        if (label) label.textContent = 'OFF';
      }
      toast('操作失败，请重试', 'error');
    });
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
      await new Promise(function (r) { setTimeout(r, 2000); });
    } else {
      toast('代理启动失败: ' + (proxyResult.message || '未知错误'), 'error');
      return;
    }
  }

  var endpoint;
  switch (mode) {
    case 'cli': endpoint = '/api/codex/start-cli'; break;
    case 'app':
    case 'app-store': endpoint = '/api/codex/start-app?version=store'; break;
    case 'app-exe': endpoint = '/api/codex/start-app?version=exe'; break;
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
    var arrowBtn = document.getElementById('btn-codex-app-arrow');
    var variantStore = document.getElementById('btn-codex-variant-store');
    var variantExe = document.getElementById('btn-codex-variant-exe');

    var hasStore = r.hasStore === true;
    var hasExe = r.hasExe === true;
    var anyAvailable = hasStore || hasExe;

    if (appBtn) {
      appBtn.disabled = !anyAvailable;
      if (hasStore) {
        appBtn.textContent = '启动 Codex Store 版';
        _codexAppVariant = 'store';
      } else if (hasExe) {
        appBtn.textContent = '启动 Codex 桌面版';
        _codexAppVariant = 'exe';
      }
      appBtn.title = anyAvailable ? '启动 Codex 桌面应用' : '未安装 Codex';
    }
    if (arrowBtn) arrowBtn.disabled = !anyAvailable;
    if (variantStore) {
      if (!hasStore) variantStore.style.opacity = '0.4';
      variantStore.style.pointerEvents = hasStore ? '' : 'none';
    }
    if (variantExe) {
      if (!hasExe) variantExe.style.opacity = '0.4';
      variantExe.style.pointerEvents = hasExe ? '' : 'none';
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

// ==================== Codex App variant (Store vs Installer) ====================

var _codexAppVariant = 'store'; // 'store' or 'exe'

function toggleCodexAppVariant() {
  var menu = document.getElementById('btn-codex-app-menu');
  if (!menu) return;
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function selectCodexAppVariant(variant) {
  _codexAppVariant = variant;
  var mainBtn = document.getElementById('btn-codex-app');
  var variantStore = document.getElementById('btn-codex-variant-store');
  var variantExe = document.getElementById('btn-codex-variant-exe');
  var menu = document.getElementById('btn-codex-app-menu');

  if (variant === 'store') {
    mainBtn.textContent = '启动 Codex Store 版';
    if (variantStore) variantStore.className = 'btn-split-item active';
    if (variantExe) variantExe.className = 'btn-split-item';
  } else {
    mainBtn.textContent = '启动 Codex 桌面版';
    if (variantStore) variantStore.className = 'btn-split-item';
    if (variantExe) variantExe.className = 'btn-split-item active';
  }
  if (menu) menu.style.display = 'none';
}

function startCodexAppVariant() {
  startCodex(_codexAppVariant === 'store' ? 'app-store' : 'app-exe');
}

// Close dropdown when clicking elsewhere
document.addEventListener('click', function(e) {
  var menu = document.getElementById('btn-codex-app-menu');
  var wrap = document.getElementById('btn-codex-app-wrap');
  if (menu && wrap && !wrap.contains(e.target)) {
    menu.style.display = 'none';
  }
});

// ==================== Quick Apply Config ====================

async function quickApply() {
  var mainProvider = document.getElementById('quick-provider').value;
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

  // The quick-config selection is the source of truth.
  // Do not silently replace it with the first model returned by /v1/models, because
  // Codex may advertise placeholder or duplicate model names that are not the model
  // the user explicitly applied here.
  var actualModel = model;

  var actualAuxModel = '';
  if (auxProvider && auxModel) {
    actualAuxModel = auxModel;
  } else {
    actualAuxModel = actualModel;
  }

  await api('/api/update-aux-model', 'POST', {
    mainModel: actualModel,
    mainProvider: mainProvider || null,
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

// 初始化：加载上下文裁剪配置并启动节省数据刷新（在主面板和设置页面都生效）
loadTrimConfig();

