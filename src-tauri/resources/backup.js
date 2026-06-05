// Dependencies: common.js
// ==================== Codex Backup & Restore ====================

async function loadBackupList() {
  try {
    var d = await api('/api/codex-backup/list');
    var statusEl = document.getElementById('backup-status');
    var listEl = document.getElementById('backup-list');
    if (d.isModified) {
      statusEl.innerHTML = '✓ Codex 配置已被 Codex Assistant 修改（自动备份已完成）';
      statusEl.style.color = 'var(--success)';
    } else {
      statusEl.innerHTML = '⚠ Codex 配置未被修改（由 Codex 或其他工具管理）';
      statusEl.style.color = 'var(--warning)';
    }
    if (!d.backups || d.backups.length === 0) {
      listEl.innerHTML = '<div style="color:var(--text-muted);font-size:var(--text-sm);padding:var(--space-2);">暂无备份</div>';
      return;
    }
    listEl.innerHTML = d.backups.map(function (b) {
      var date = new Date(b.time);
      var dateStr = date.getFullYear() + '年' +
        String(date.getMonth()+1).padStart(2,'0') + '月' +
        String(date.getDate()).padStart(2,'0') + '日 ' +
        String(date.getHours()).padStart(2,'0') + ':' +
        String(date.getMinutes()).padStart(2,'0');
      var isAuto = b.name.includes('自动') || b.name.includes('auto');
      var nameShort = b.name.replace(/\.zip$/i, '');
      // Lock SVG icon
      var lockSvg = b.locked
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="backup-lock-icon locked"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="backup-lock-icon"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path><line x1="12" y1="15" x2="12" y2="19"></line></svg>';
      // Folder SVG icon
      var folderSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="backup-action-icon"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
      // Delete SVG icon
      var delSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="backup-action-icon"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
      return '<div class="backup-item">' +
        '<div class="backup-row1">' +
          '<button class="backup-lock-btn" onclick="toggleLockBackup(\'' + escAttr(b.name) + '\',' + !b.locked + ')" title="' + (b.locked ? '已锁定，点击解锁' : '未锁定，点击锁定') + '">' + lockSvg + '</button>' +
          '<span class="backup-name" title="' + escAttr(b.name) + '">' + escHtml(nameShort) + '</span>' +
          (isAuto ? '<span class="backup-tag">自动</span>' : '<span class="backup-tag manual">手动</span>') +
          '<span class="backup-date">' + dateStr + '</span>' +
        '</div>' +
        '<div class="backup-row2">' +
          '<button class="backup-action-btn" onclick="restoreBackup(\'' + escAttr(b.name) + '\')">恢复</button>' +
          '<button class="backup-action-btn" onclick="renameBackup(\'' + escAttr(b.name) + '\')">重命名</button>' +
          '<button class="backup-action-btn" onclick="openBackupFolder()">' + folderSvg + ' 打开文件夹</button>' +
          '<button class="backup-action-btn backup-delete-btn' + (b.locked ? ' disabled' : '') + '" onclick="' + (b.locked ? 'return' : 'deleteBackup(\'' + escAttr(b.name) + '\')') + '" title="' + (b.locked ? '已锁定，无法删除' : '删除此备份') + '"' + (b.locked ? ' disabled' : '') + '>' + delSvg + ' 删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    toast('加载备份列表失败: ' + e.message, 'error');
  }
}

async function createBackup() {
  try {
    var result = await api('/api/codex-backup/create', 'POST');
    if (result.skipped) {
      toast(result.message, 'warning');
    } else if (result.success) {
      toast('备份已创建');
      await loadBackupList();
    } else {
      toast(result.error || '备份失败', 'error');
    }
  } catch (e) {
    toast('备份失败: ' + e.message, 'error');
  }
}

async function restoreBackup(name) {
  if (!confirm('确定要恢复备份 "' + name + '" 吗？\n\n当前配置将被备份，然后恢复为备份版本。\n恢复后需要重启 Codex 才能生效。')) return;
  try {
    var result = await api('/api/codex-backup/restore', 'POST', { name: name });
    if (result.success) {
      toast(result.message || '恢复成功');
      await loadBackupList();
    } else {
      toast(result.error || '恢复失败', 'error');
    }
  } catch (e) {
    toast('恢复失败: ' + e.message, 'error');
  }
}

async function deleteBackup(name) {
  if (!confirm('确定要删除备份 "' + name + '" 吗？')) return;
  try {
    var result = await api('/api/codex-backup/delete', 'POST', { name: name });
    if (result.success) {
      toast('备份已删除');
      await loadBackupList();
    } else {
      toast(result.error || '删除失败', 'error');
    }
  } catch (e) {
    toast('删除失败: ' + e.message, 'error');
  }
}

async function toggleLockBackup(name, locked) {
  try {
    var result = await api('/api/codex-backup/lock', 'POST', { name: name, locked: locked });
    if (result.success) {
      toast(locked ? '备份已锁定' : '备份已解锁');
      await loadBackupList();
    } else {
      toast(result.error || '操作失败', 'error');
    }
  } catch (e) {
    toast('操作失败: ' + e.message, 'error');
  }
}

async function renameBackup(name) {
  var newName = prompt('输入新的备份名称（不含 .zip 后缀）：', name.replace('codex-backup-', '').replace('.zip', ''));
  if (!newName || newName === name.replace('codex-backup-', '').replace('.zip', '')) return;
  var fullName = 'codex-backup-' + newName + '.zip';
  try {
    var result = await api('/api/codex-backup/rename', 'POST', { name: name, newName: fullName });
    if (result.success) {
      toast('重命名成功');
      await loadBackupList();
    } else {
      toast(result.error || '重命名失败', 'error');
    }
  } catch (e) {
    toast('重命名失败: ' + e.message, 'error');
  }
}

function openBackupFolder() {
  api('/api/codex-backup/list').then(function (d) {
    if (d.backupDir) {
      api('/api/open-folder', 'POST', { path: d.backupDir });
    }
  });
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

