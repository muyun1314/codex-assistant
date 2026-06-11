// Dependencies: common.js
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
  if (!confirm('⚠ 确定要随机刷新访问密钥吗？新密钥将同步到 Codex 配置。')) return;
  
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

function setLogFilter(val) {
  logFilter = val;
  document.querySelectorAll('.log-filter-btn').forEach(function (b) { b.classList.remove('active'); });
  var btn = document.getElementById('log-filter-' + val);
  if (btn) btn.classList.add('active');
  loadLogs();
}

async function loadLogs() {
  try {
    var d = await api('/api/logs?limit=500');
    var logs = d.logs || [];
    // Sort by timestamp to ensure chronological order
    logs.sort(function(a, b) {
      return (new Date(a.time || 0).getTime() || 0) - (new Date(b.time || 0).getTime() || 0);
    });
    if (logFilter !== 'all') logs = logs.filter(function (l) { return l.type === logFilter; });
    var box = document.getElementById('log-box');
    if (logs.length === 0) {
      // 区分"代理未启动"和"暂无日志"
      try {
        var st = await api('/api/status');
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
        var cls = type === 'error' ? 'log-stderr' : type === 'warn' ? 'log-warn' : type === 'system' ? 'log-system' : 'log-stdout';
        return '<div class="log-entry"><span class="log-time">[' + new Date(l.time).toLocaleTimeString() + ']</span> <span class="' + cls + '">' + escHtml(l.msg) + '</span></div>';
      }).join('');
    }
    box.scrollTop = box.scrollHeight;
  } catch (e) { /* transient failure, will retry */ }
}

async function exportLogs() {
  try {
    var d = await api('/api/logs/export');
    var text = d.text || '';
    if (!text.trim()) { toast('没有可导出的日志', 'error'); return; }
    var defaultName = 'codex-assistant-log-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.txt';
    var result = await api('/api/save-file', 'POST', {
      title: '导出日志',
      content: text,
      defaultName: defaultName,
      filter: '文本文件 (*.txt)|*.txt|所有文件 (*.*)|*.*'
    });
    if (result.success) {
      toast('日志已保存到: ' + result.path + '（共 ' + (d.lineCount || 0) + ' 行）');
    } else if (result.message !== '未选择保存路径') {
      toast('导出失败: ' + result.message, 'error');
    }
  } catch (e) {
    toast('导出日志失败: ' + e.message, 'error');
  }
}

// ==================== 操作日志查看 ====================
var opLogTab = 'proxy';

function switchLogTab(tab) {
  opLogTab = tab;
  document.querySelectorAll('.oplog-tab').forEach(function (b) { b.classList.remove('active'); });
  document.getElementById('oplog-tab-' + tab).classList.add('active');
  document.getElementById('log-panel-proxy').style.display = tab === 'proxy' ? '' : 'none';
  document.getElementById('log-panel-operations').style.display = tab === 'operations' ? '' : 'none';
  if (tab === 'operations') loadOperationLogs();
}

async function loadOperationLogs() {
  var box = document.getElementById('oplog-box');
  var category = document.getElementById('oplog-filter-category').value;
  var success = document.getElementById('oplog-filter-success').value;
  try {
    var params = 'limit=200';
    if (category) params += '&category=' + encodeURIComponent(category);
    if (success) params += '&success=' + success;
    var d = await api('/api/operation-logs?' + params);
    var items = d.items || [];
    if (items.length === 0) {
      box.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:40px;">暂无操作日志</div>';
      return;
    }
    var rows = '<table class="oplog-table"><thead><tr><th style="width:80px;">时间</th><th style="width:60px;">分类</th><th style="width:70px;">操作</th><th>详情</th><th style="width:50px;">结果</th></tr></thead><tbody>';
    for (var i = items.length - 1; i >= 0; i--) {
      var item = items[i];
      var time = new Date(item.time).toLocaleTimeString();
      var resultBadge = item.success
        ? '<span class="oplog-success">成功</span>'
        : '<span class="oplog-fail" title="' + escHtml(item.error || '') + '">失败</span>';
      var detail = escHtml(item.detail || '');
      if (!item.success && item.error) {
        detail += ' <span class="oplog-error-detail">(' + escHtml(item.error) + ')</span>';
      }
      rows += '<tr><td>' + time + '</td><td>' + escHtml(item.category) + '</td><td>' + escHtml(item.action) + '</td><td>' + detail + '</td><td>' + resultBadge + '</td></tr>';
    }
    rows += '</tbody></table>';
    box.innerHTML = rows;
  } catch (e) {
    box.innerHTML = '<div style="color:var(--error-color);text-align:center;padding:40px;">加载失败: ' + escHtml(e.message) + '</div>';
  }
}

