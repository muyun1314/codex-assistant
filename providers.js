// ============================================================
// Codex Assistant — Provider Management
// ============================================================

async function loadProviders() {
  try {
    var data = await api('/api/providers');
    providers = data;
    renderProviders();
    fillModelSelect();
    fillAuxProviderSelect();
  } catch (e) {
    toast('加载提供商列表失败: ' + e.message, 'error');
  }
}

function renderProviders() {
  var list = document.getElementById('provider-list');
  if (!list) return;

  if (!providers.providers || providers.providers.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无提供商，点击上方按钮添加</div>';
    return;
  }

  list.innerHTML = providers.providers.map(function(p, i) {
    var name = escHtml(p.name || p.id || '未命名');
    var protocol = escHtml(p.protocol || 'openai');
    var keyStatus = '';
    var warningTitle = '';
    var keyActions = '';

    if (p._decrypt_warning) {
      keyStatus = ' <span style="color:var(--danger);font-size:var(--text-xs);" title="' + escAttr(p._decrypt_warning) + '">⚠ 需重新输入</span>';
      warningTitle = escAttr(p._decrypt_warning);
      keyActions = '<span style="color:var(--danger);font-size:var(--text-xs);">⚠ 密钥已丢失，请编辑重新输入</span>';
    } else if (p.api_key) {
      keyStatus = ' <span style="color:var(--success);font-size:var(--text-xs);">● 已填写</span>';
      keyActions = '<button class="btn btn-xs btn-secondary" onclick="testProviderConnection(' + i + ')">测试连接</button>';
    } else {
      keyStatus = ' <span style="color:var(--text-muted);font-size:var(--text-xs);">○ 未填写</span>';
    }

    var modelCount = (p.models && p.models.length) ? p.models.length : 0;
    var statusIcon = (p.status === 'connected' || p.status === 'active') ? '🟢' : '🔴';
    var statusText = p.status || '未知';

    return '<div class="provider-card">' +
      '<div class="provider-card-header">' +
        '<div class="provider-name">' + statusIcon + ' ' + name + '</div>' +
        '<div class="provider-actions">' +
          keyActions +
          '<button class="btn btn-xs btn-secondary" onclick="editProvider(' + i + ')">✎ 编辑</button>' +
          '<button class="btn btn-xs btn-danger" onclick="deleteProvider(' + i + ')" style="margin-left:4px;">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="provider-card-body">' +
        '<div class="provider-info">协议: ' + protocol + ' | 模型数: ' + modelCount + ' | 状态: ' + statusText + keyStatus + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ---------- Provider Modal ----------

function showProviderModal(idx) {
  var modal = document.getElementById('provider-modal');
  var mask = document.getElementById('provider-modal-mask');
  if (!modal || !mask) return;

  var p = (idx >= 0 && providers.providers && providers.providers[idx]) ? providers.providers[idx] : {};
  var isNew = idx < 0 || !p.name;

  document.getElementById('pm-title').textContent = isNew ? '添加提供商' : '编辑提供商';
  document.getElementById('pm-name').value = p.name || '';
  document.getElementById('pm-id').value = p.id || p.name || '';
  document.getElementById('pm-base-url').value = p.base_url || '';
  document.getElementById('pm-key').value = p.api_key || '';
  document.getElementById('pm-protocol').value = p.protocol || 'openai';
  document.getElementById('pm-provider-id').value = idx >= 0 ? String(idx) : '-1';

  // Default provider checkbox
  var defaultCb = document.getElementById('pm-is-default');
  if (defaultCb) {
    defaultCb.checked = (p.name && providers.providers && currentDefaultProvider === p.name);
  }

  // Show/hide fetch models button
  var fetchBtn = document.getElementById('pm-fetch-models');
  if (fetchBtn) {
    fetchBtn.style.display = isNew ? 'none' : '';
  }

  modal.style.display = '';
  mask.style.display = '';
}

function closeProviderModal() {
  var modal = document.getElementById('provider-modal');
  var mask = document.getElementById('provider-modal-mask');
  if (modal) modal.style.display = 'none';
  if (mask) mask.style.display = 'none';
}

function onDefaultProviderChange() {
  var cb = document.getElementById('pm-is-default');
  if (!cb) return;
}

async function fetchModels() {
  var idx = parseInt(document.getElementById('pm-provider-id').value);
  if (idx < 0 || !providers.providers || !providers.providers[idx]) return;

  var btn = document.getElementById('pm-fetch-models');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '获取中...';
  }

  try {
    var result = await api('/api/providers/' + idx + '/fetch-models', 'POST');
    if (result.success) {
      toast('成功获取 ' + (result.models ? result.models.length : 0) + ' 个模型');
      await loadProviders();
      closeProviderModal();
    } else {
      toast('获取模型失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('获取模型失败: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '拉取模型列表';
    }
  }
}

async function saveProvider() {
  var idx = parseInt(document.getElementById('pm-provider-id').value);
  var data = {
    name: document.getElementById('pm-name').value.trim(),
    id: document.getElementById('pm-id').value.trim() || document.getElementById('pm-name').value.trim(),
    base_url: document.getElementById('pm-base-url').value.trim(),
    api_key: document.getElementById('pm-key').value.trim(),
    protocol: document.getElementById('pm-protocol').value,
  };

  if (!data.name) {
    toast('请输入提供商名称', 'warning');
    return;
  }

  // Handle default provider
  var isDefault = document.getElementById('pm-is-default');
  if (isDefault && isDefault.checked) {
    data.isDefault = true;
  }

  try {
    var result;
    if (idx >= 0) {
      result = await api('/api/providers/' + idx, 'PUT', data);
    } else {
      result = await api('/api/providers', 'POST', data);
    }

    if (result.success) {
      toast('保存成功 ✓');
      closeProviderModal();
      await loadProviders();
    } else {
      toast('保存失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
  }
}

function editProvider(i) { showProviderModal(i); }

async function deleteProvider(i) {
  if (!confirm('确定删除该提供商吗？')) return;
  try {
    var result = await api('/api/providers/' + i, 'DELETE');
    if (result.success) {
      toast('已删除');
      await loadProviders();
    } else {
      toast('删除失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('删除失败: ' + e.message, 'error');
  }
}

async function setDefaultProvider(name) {
  try {
    var result = await api('/api/providers/set-default', 'POST', { name: name });
    if (result.success) {
      currentDefaultProvider = name;
      toast('已设为默认提供商');
      await loadProviders();
    } else {
      toast('设置失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('设置失败: ' + e.message, 'error');
  }
}

async function removeModel(pi, slug) {
  if (!confirm('确定移除该模型吗？')) return;
  try {
    var result = await api('/api/providers/' + pi + '/models/' + encodeURIComponent(slug), 'DELETE');
    if (result.success) {
      toast('模型已移除');
      await loadProviders();
    } else {
      toast('移除失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('移除失败: ' + e.message, 'error');
  }
}

async function generateModels() {
  try {
    var result = await api('/api/generate-models', 'POST');
    if (result.success) {
      toast('模型列表已刷新');
      await loadProviders();
    } else {
      toast('刷新失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('刷新失败: ' + e.message, 'error');
  }
}

async function testProviderConnection(idx) {
  if (!providers.providers || !providers.providers[idx]) return;
  var name = providers.providers[idx].name;
  try {
    var result = await api('/api/providers/' + idx + '/test', 'POST');
    if (result.success) {
      toast(name + ' 连接成功 ✓');
    } else {
      toast(name + ' 连接失败: ' + (result.error || result.message), 'error');
    }
    await loadProviders();
  } catch (e) {
    toast(name + ' 连接失败: ' + e.message, 'error');
  }
}
