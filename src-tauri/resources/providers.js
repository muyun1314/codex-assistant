// Dependencies: common.js
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
          (p._decrypt_warning ? '<span style="color:var(--warning);font-size:var(--text-xs);margin-right:var(--space-2);">⚠ 加密环境发生改变，密钥无法解密，请编辑重新输入</span>' : (p.api_key ? '<button class="btn btn-sm btn-secondary" onclick="testProviderConnection(' + i + ')">测试连接</button>' : '')) +
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

