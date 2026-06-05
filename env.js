// ============================================================
// Codex Assistant — Environment Configuration & Logs
// ============================================================

// ---------- Import / Export ----------

async function exportConfig() {
  try {
    var result = await api('/api/export-config');
    if (result.success && result.data) {
      var blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'codex-assistant-config-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
      toast('配置已导出');
    } else {
      toast('导出失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('导出失败: ' + e.message, 'error');
  }
}

function importConfig() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async function() {
    var file = input.files[0];
    if (!file) return;
    try {
      var text = await file.text();
      var data = JSON.parse(text);
      var result = await api('/api/import-config', 'POST', data);
      if (result.success) {
        toast('配置导入成功，正在刷新...');
        setTimeout(function() { location.reload(); }, 1000);
      } else {
        toast('导入失败: ' + (result.error || result.message), 'error');
      }
    } catch (e) {
      toast('导入失败: ' + e.message, 'error');
    }
  };
  input.click();
}

// ---------- Env Config ----------

var ENV_CONFIG = {
  basic: [
    { key: 'PROXY_PORT', label: '代理端口', type: 'number', placeholder: '4000', desc: '代理监听端口，Codex 需连接此端口' },
    { key: 'PROXY_AUTH_KEY', label: '访问密钥', type: 'text', placeholder: '留空则不限制访问', desc: '与 Codex 通信的访问密钥。首次从 Codex 同步，修改后也会同步回 Codex，若是在codex中输入了提供商的API Key，请及时随机刷新防止泄露', hasRefresh: true, hasSync: true },
    { key: 'DEFAULT_PROVIDER', label: '默认提供商', type: 'select-provider', desc: '未指定模型时使用哪个提供商和模型' }
  ],
  advanced: [
    { key: 'LOG_LEVEL', label: '日志级别', type: 'select', options: ['debug', 'info', 'warn', 'error'], desc: '控制日志输出的详细程度' },
    { key: 'REQUEST_TIMEOUT', label: '请求超时(秒)', type: 'number', placeholder: '120', desc: '上游 API 请求超时时间' },
    { key: 'MAX_RETRIES', label: '最大重试次数', type: 'number', placeholder: '3', desc: '上游 API 失败时的重试次数' },
    { key: 'RATE_LIMIT_RPM', label: '速率限制(RPM)', type: 'number', placeholder: '0', desc: '每分钟最大请求数，0 表示不限制' }
  ]
};

function generateRandomKey() {
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var key = 'sk-';
  for (var i = 0; i < 48; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

function refreshAuthKey() {
  if (!confirm('⚠ 确定要随机刷新访问密钥吗？刷新后可能需要重新输入相关配置。')) return;

  var newKey = generateRandomKey();
  document.getElementById('env-PROXY_AUTH_KEY').value = newKey;
  var syncCheckbox = document.getElementById('sync-codex-key');
  if (syncCheckbox) syncCheckbox.checked = true;
  toast('已生成新密钥，保存后将同步到 Codex 配置', 'info');
}

async function loadEnv() {
  try {
    var d = await api('/api/env');
    var form = document.getElementById('env-form');

    // 首次访问自动生成随机密钥
    if (!d.PROXY_AUTH_KEY) {
      var newKey = generateRandomKey();
      d.PROXY_AUTH_KEY = newKey;
      await api('/api/env', 'PUT', { PROXY_AUTH_KEY: newKey, CODEX_API_KEY: newKey });
      toast('已自动生成访问密钥');
    }

    if (form) {
      // Render basic env fields
      var container = form.querySelector('#env-basic-fields');
      if (container) {
        container.innerHTML = ENV_CONFIG.basic.map(function(cfg) {
          if (cfg.type === 'select-provider') {
            var options = '<option value="">自动选择</option>';
            (providers.providers || []).forEach(function(p) {
              var name = p.name || p.id;
              options += '<option value="' + escAttr(name) + '">' + escHtml(name) + '</option>';
            });
            return '<label>' + cfg.label + '</label>' +
              '<select id="env-' + cfg.key + '">' + options + '</select>' +
              '<div class="form-hint">' + cfg.desc + '</div>';
          }
          var attrs = '';
          if (cfg.type === 'number') attrs = 'type="number"';
          if (cfg.placeholder) attrs += ' placeholder="' + escAttr(cfg.placeholder) + '"';
          var refreshBtn = cfg.hasRefresh ? '<button type="button" class="btn btn-xs btn-secondary" onclick="refreshAuthKey()" style="margin-left:4px;">随机刷新</button>' : '';
          return '<label>' + cfg.label + refreshBtn + '</label>' +
            '<input id="env-' + cfg.key + '" ' + attrs + '>' +
            '<div class="form-hint">' + cfg.desc + '</div>';
        }).join('');
      }

      // Render advanced env fields
      var advContainer = form.querySelector('#env-advanced-fields');
      if (advContainer) {
        advContainer.innerHTML = ENV_CONFIG.advanced.map(function(cfg) {
          if (cfg.type === 'select') {
            var options = cfg.options.map(function(o) {
              return '<option value="' + o + '">' + o + '</option>';
            }).join('');
            return '<label>' + cfg.label + '</label>' +
              '<select id="env-' + cfg.key + '">' + options + '</select>' +
              '<div class="form-hint">' + cfg.desc + '</div>';
          }
          return '<label>' + cfg.label + '</label>' +
            '<input id="env-' + cfg.key + '" type="number" placeholder="' + escAttr(cfg.placeholder || '') + '">' +
            '<div class="form-hint">' + cfg.desc + '</div>';
        }).join('');
      }

      // Fill values
      Object.keys(d).forEach(function(k) {
        var el = document.getElementById('env-' + k);
        if (el) {
          if (el.tagName === 'SELECT') {
            el.value = d[k];
          } else {
            el.value = d[k] || '';
          }
        }
      });
    }
  } catch (e) {
    toast('加载环境配置失败: ' + e.message, 'error');
  }
}

function toggleSection(sectionId) {
  var section = document.getElementById(sectionId);
  if (!section) return;
  var body = section.querySelector('.section-body');
  if (!body) return;
  var isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
}

async function saveEnv() {
  var d = {};
  ENV_CONFIG.basic.concat(ENV_CONFIG.advanced).forEach(function(cfg) {
    var el = document.getElementById('env-' + cfg.key);
    if (el) d[cfg.key] = el.value;
  });

  var syncCheckbox = document.getElementById('sync-codex-key');
  if (syncCheckbox && syncCheckbox.checked && d.PROXY_AUTH_KEY) {
    d.CODEX_API_KEY = d.PROXY_AUTH_KEY;
  }

  try {
    var result = await api('/api/env', 'PUT', d);
    if (result.success) {
      toast('环境配置已保存');
      if (currentDefaultProvider !== d.DEFAULT_PROVIDER) {
        currentDefaultProvider = d.DEFAULT_PROVIDER || '';
      }
    } else {
      toast('保存失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
  }
}

async function saveEnvAndRestart() {
  await saveEnv();
  toast('配置已保存，正在重启代理...');
  await restartProxy();
}

// ---------- Logs ----------

async function loadLogConfig() {
  try {
    var cfg = await api('/api/log-config');
    var el = document.getElementById('log-filter');
    if (el) el.value = cfg.level || 'info';
    var autoScrollEl = document.getElementById('log-auto-scroll');
    if (autoScrollEl && cfg.autoScroll !== undefined) autoScrollEl.checked = cfg.autoScroll;
  } catch (e) { /* non-critical */ }
}

async function saveLogConfig() {
  var level = document.getElementById('log-filter').value;
  var autoScroll = document.getElementById('log-auto-scroll').checked;
  try {
    await api('/api/log-config', 'PUT', { level: level, autoScroll: autoScroll });
    toast('日志配置已保存');
  } catch (e) {
    toast('保存日志配置失败: ' + e.message, 'error');
  }
}

async function saveLogConfigAndRestart() {
  await saveLogConfig();
  toast('日志配置已保存，正在重启代理...');
  await restartProxy();
}

function setLogFilter(val) {
  document.getElementById('log-filter').value = val;
  saveLogConfig();
}

async function loadLogs() {
  try {
    var data = await api('/api/logs');
    var el = document.getElementById('log-content');
    if (el) {
      el.textContent = data.logs || '';
      var autoScroll = document.getElementById('log-auto-scroll');
      if (autoScroll && autoScroll.checked) {
        el.scrollTop = el.scrollHeight;
      }
    }
  } catch (e) {
    var el = document.getElementById('log-content');
    if (el) el.textContent = '加载日志失败: ' + e.message;
  }
}

async function exportLogs() {
  try {
    var data = await api('/api/logs/export');
    if (data.content) {
      var blob = new Blob([data.content], { type: 'text/plain' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'codex-assistant-logs-' + new Date().toISOString().slice(0, 10) + '.txt';
      a.click();
      URL.revokeObjectURL(url);
      toast('日志已导出');
    }
  } catch (e) {
    toast('导出日志失败: ' + e.message, 'error');
  }
}
