// ============================================================
// Codex Assistant — Dashboard (proxy control, codex management)
// ============================================================

// ---------- Proxy Control ----------

async function toggleProxy() {
  var btn = document.getElementById('btn-start-stop');
  var isRunning = document.getElementById('status-dot').classList.contains('on');
  if (isRunning) {
    await stopCodex();
  } else {
    await startCodex('proxy');
  }
}

async function restartProxy() {
  await stopCodex();
  await startCodex('proxy');
}

async function startCodex(mode) {
  var btn = document.getElementById('btn-start-stop');
  var origText = btn ? btn.textContent : '';
  if (btn) {
    btn.textContent = '启动中...';
    btn.disabled = true;
  }
  try {
    var result = await api('/api/start', 'POST', { mode: mode || 'proxy' });
    if (result.success) {
      await loadStatus();
      toast('代理已启动');
    } else {
      toast('启动失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('启动失败: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.textContent = origText;
      btn.disabled = false;
    }
  }
}

async function stopCodex() {
  var btn = document.getElementById('btn-start-stop');
  var origText = btn ? btn.textContent : '';
  if (btn) {
    btn.textContent = '停止中...';
    btn.disabled = true;
  }
  try {
    var result = await api('/api/stop', 'POST');
    if (result.success) {
      await loadStatus();
      toast('代理已停止');
    } else {
      toast('停止失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('停止失败: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.textContent = origText;
      btn.disabled = false;
    }
  }
}

async function checkCodexInstalled() {
  try {
    var result = await api('/api/codex-installed');
    var el = document.getElementById('codex-check-result');
    if (el) {
      if (result.installed) {
        el.innerHTML = '<span style="color:var(--success);">✓ Codex CLI 已安装: v' + escHtml(result.version) + '</span>';
      } else {
        el.innerHTML = '<span style="color:var(--warning);">⚠ Codex CLI 未安装，代理功能不可用</span>';
      }
    }
  } catch (e) {
    console.error('[ui] Codex check failed:', e);
  }
}

// ---------- Quick Apply ----------

async function quickApply() {
  var modelSel = document.getElementById('model-select');
  var auxModelSel = document.getElementById('aux-model-select');
  var model = modelSel ? modelSel.value : '';
  var auxModel = auxModelSel ? auxModelSel.value : '';

  if (!model) {
    toast('请先选择一个模型', 'warning');
    return;
  }

  // Determine provider from model
  var provider = '';
  var allModels = [];
  (providers.providers || []).forEach(function(p) {
    (p.models || []).forEach(function(m) {
      var slug = m.slug || m.id;
      allModels.push({ slug: slug, provider: p.name });
      if (slug === model) provider = p.name;
    });
  });

  if (!provider) {
    toast('未找到模型对应的提供商', 'error');
    return;
  }

  try {
    // Save current model selection as defaults
    await api('/api/save-defaults', 'POST', {
      model: model,
      provider: provider
    });

    // Save aux model if selected
    if (auxModel) {
      await api('/api/set-aux-model', 'POST', { auxModel: auxModel });
    }

    // Apply to Codex config
    var result = await api('/api/apply-config', 'POST');
    if (result.success) {
      currentAppliedModel = model;
      if (auxModel) currentAuxModel = auxModel;
      updateCurrentModelDisplay(allModels.map(function(m) {
        var prov = (providers.providers || []).find(function(p2) {
          return (p2.models || []).some(function(m2) { return (m2.slug || m2.id) === m.slug; });
        });
        return { slug: m.slug, name: m.slug, provider: prov ? prov.name : '' };
      }));
      toast('配置已应用 ✓');
    } else {
      toast('配置失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('配置失败: ' + e.message, 'error');
  }
}
