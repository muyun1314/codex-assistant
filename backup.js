// ============================================================
// Codex Assistant — Backup & Codexpp Management
// ============================================================

async function loadBackupList() {
  try {
    var data = await api('/api/backups');
    var list = document.getElementById('backup-list');
    if (!list) return;

    if (!data.backups || data.backups.length === 0) {
      list.innerHTML = '<div class="empty-state">暂无备份</div>';
      return;
    }

    list.innerHTML = data.backups.map(function(b) {
      var locked = b.locked ? ' 🔒' : '';
      var lockAction = b.locked
        ? '<button class="btn btn-xs btn-secondary" onclick="toggleLockBackup(\'' + escAttr(b.name) + '\', false)">解锁</button>'
        : '<button class="btn btn-xs btn-secondary" onclick="toggleLockBackup(\'' + escAttr(b.name) + '\', true)">锁定</button>';

      return '<div class="backup-item">' +
        '<div class="backup-info">' +
          '<span class="backup-name">' + escHtml(b.name) + locked + '</span>' +
          '<span class="backup-date">' + escHtml(b.date || '') + '</span>' +
          '<span class="backup-size">' + escHtml(b.size || '') + '</span>' +
        '</div>' +
        '<div class="backup-actions">' +
          '<button class="btn btn-xs btn-success" onclick="restoreBackup(\'' + escAttr(b.name) + '\')">恢复</button>' +
          '<button class="btn btn-xs btn-secondary" onclick="renameBackup(\'' + escAttr(b.name) + '\')">重命名</button>' +
          lockAction +
          '<button class="btn btn-xs btn-danger" onclick="deleteBackup(\'' + escAttr(b.name) + '\')">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    toast('加载备份列表失败: ' + e.message, 'error');
  }
}

async function createBackup() {
  try {
    var result = await api('/api/backups', 'POST');
    if (result.success) {
      toast('备份已创建: ' + result.name);
      await loadBackupList();
    } else {
      toast('创建备份失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('创建备份失败: ' + e.message, 'error');
  }
}

async function restoreBackup(name) {
  if (!confirm('确定恢复备份 "' + name + '" 吗？当前配置将被覆盖。')) return;
  try {
    var result = await api('/api/backups/' + encodeURIComponent(name) + '/restore', 'POST');
    if (result.success) {
      toast('备份已恢复，正在重启...');
      setTimeout(function() { location.reload(); }, 1000);
    } else {
      toast('恢复失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('恢复失败: ' + e.message, 'error');
  }
}

async function deleteBackup(name) {
  if (!confirm('确定删除备份 "' + name + '" 吗？此操作不可撤销。')) return;
  try {
    var result = await api('/api/backups/' + encodeURIComponent(name), 'DELETE');
    if (result.success) {
      toast('备份已删除');
      await loadBackupList();
    } else {
      toast('删除失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('删除失败: ' + e.message, 'error');
  }
}

async function toggleLockBackup(name, locked) {
  try {
    var result = await api('/api/backups/' + encodeURIComponent(name) + '/lock', 'PUT', { locked: locked });
    if (result.success) {
      toast(locked ? '备份已锁定' : '备份已解锁');
      await loadBackupList();
    } else {
      toast('操作失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('操作失败: ' + e.message, 'error');
  }
}

async function renameBackup(name) {
  var newName = prompt('请输入新名称:', name);
  if (!newName || newName === name) return;
  try {
    var result = await api('/api/backups/' + encodeURIComponent(name) + '/rename', 'PUT', { newName: newName });
    if (result.success) {
      toast('已重命名为: ' + newName);
      await loadBackupList();
    } else {
      toast('重命名失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('重命名失败: ' + e.message, 'error');
  }
}

function openBackupFolder() {
  api('/api/open-backup-folder', 'POST');
}

// ---------- Codexpp Config ----------

async function loadCodexppConfig() {
  try {
    var cfg = await api('/api/codexpp-config');
    var el = document.getElementById('codexpp-path');
    if (el) el.value = cfg.path || '';
    var autoEl = document.getElementById('codexpp-auto-path');
    if (autoEl) autoEl.textContent = cfg.autoDetected || '未检测到';
  } catch (e) { /* non-critical */ }
}

async function selectCodexppPath() {
  try {
    var result = await api('/api/select-codexpp-path', 'POST');
    if (result.path) {
      document.getElementById('codexpp-path').value = result.path;
      toast('路径已选择');
    }
  } catch (e) {
    toast('选择路径失败: ' + e.message, 'error');
  }
}

async function saveCodexppConfig() {
  var path = document.getElementById('codexpp-path').value.trim();
  try {
    var result = await api('/api/codexpp-config', 'PUT', { path: path });
    if (result.success) {
      toast('Codexpp 路径已保存');
    } else {
      toast('保存失败: ' + (result.error || result.message), 'error');
    }
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
  }
}

async function autoDetectCodexpp() {
  try {
    var result = await api('/api/auto-detect-codexpp', 'POST');
    if (result.path) {
      document.getElementById('codexpp-path').value = result.path;
      document.getElementById('codexpp-auto-path').textContent = result.path;
      toast('已自动检测到 Codexpp 路径');
    } else {
      toast('未检测到 Codexpp');
    }
  } catch (e) {
    toast('检测失败: ' + e.message, 'error');
  }
}
