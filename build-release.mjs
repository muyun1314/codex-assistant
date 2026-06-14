#!/usr/bin/env node
// ============================================================
// Codex Assistant 发布打包脚本
// 生成：便携版、NSIS安装版、MSI安装版
// 保存位置：F:\WorkSpace\codex-assistant\dist
// ============================================================

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取版本号
const versionInfo = JSON.parse(fs.readFileSync(path.join(__dirname, 'src-tauri', 'resources', 'version.json'), 'utf-8'));
const VERSION = versionInfo.version;

const DIST_DIR = path.join(__dirname, 'dist');
const RELEASE_DIR = path.join(__dirname, 'src-tauri', 'target', 'release');
const RESOURCES_DIR = path.join(__dirname, 'src-tauri', 'resources');

console.log(`\n📦 Building Codex Assistant v${VERSION}\n`);

// 清理 dist 目录（完全删除并重建）
if (fs.existsSync(DIST_DIR)) {
  try {
    fs.rmSync(DIST_DIR, { recursive: true });
  } catch (e) {
    // 如果删除失败，尝试清空目录内容
    const items = fs.readdirSync(DIST_DIR);
    for (const item of items) {
      const itemPath = path.join(DIST_DIR, item);
      try {
        fs.rmSync(itemPath, { recursive: true, force: true });
      } catch (e2) { /* ignore */ }
    }
  }
}
fs.mkdirSync(DIST_DIR, { recursive: true });
console.log('🗑️  Cleaned dist directory\n');

// ==================== 安装版 ====================
// 先进行 Tauri release build（耗时较长，生成 NSIS + MSI）
console.log('📦 Building installer packages (Tauri release build)...\n');

try {
  execSync('npm run tauri:build', {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, TAURI_SIGNING_PRIVATE_PASSWORD: '' }
  });
} catch (e) {
  console.error('❌ Tauri build failed:', e.message);
  process.exit(1);
}

// 复制安装包到 dist 目录
const tauriReleaseDir = path.join(RELEASE_DIR, 'bundle');

// NSIS 安装包
const nsisDir = path.join(tauriReleaseDir, 'nsis');
if (fs.existsSync(nsisDir)) {
  const nsisFiles = fs.readdirSync(nsisDir).filter(f => f.endsWith('.exe') && f.includes(VERSION));
  for (const file of nsisFiles) {
    const destName = `Codex-Assistant-v${VERSION}-setup.exe`;
    fs.copyFileSync(path.join(nsisDir, file), path.join(DIST_DIR, destName));
    console.log(`✅ NSIS: ${destName}`);
  }
} else {
  console.warn('⚠️  NSIS dir not found, skipping installer package');
}

// MSI 安装包
const msiDir = path.join(tauriReleaseDir, 'msi');
if (fs.existsSync(msiDir)) {
  const msiFiles = fs.readdirSync(msiDir).filter(f => f.endsWith('.msi') && f.includes(VERSION));
  for (const file of msiFiles) {
    const destName = `Codex-Assistant-v${VERSION}.msi`;
    fs.copyFileSync(path.join(msiDir, file), path.join(DIST_DIR, destName));
    console.log(`✅ MSI: ${destName}`);
  }
} else {
  console.warn('⚠️  MSI dir not found, skipping MSI package');
}

console.log('');

// ==================== 便携版 ====================
console.log('📁 Creating portable package...');

const releaseExe = path.join(RELEASE_DIR, 'codex-assistant.exe');
if (!fs.existsSync(releaseExe)) {
  console.error('❌ Release exe not found:', releaseExe);
  process.exit(1);
}

const portableDir = path.join(DIST_DIR, `Codex-Assistant-v${VERSION}-portable`);
fs.mkdirSync(portableDir, { recursive: true });

// 复制主程序
fs.copyFileSync(releaseExe, path.join(portableDir, 'codex-assistant.exe'));
console.log('  Copied: codex-assistant.exe');

// 排除的隐私目录和文件
const EXCLUDED_DIRS = ['user', 'backup', 'log', 'node_modules', '.git'];
const EXCLUDED_FILES = ['.env', 'provider-configs.json', 'aux-model-config.json'];

// 复制资源文件夹
const resourceDest = path.join(portableDir, 'resources');
if (!fs.existsSync(resourceDest)) fs.mkdirSync(resourceDest, { recursive: true });

function copyResourcesFiltered(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    // 跳过排除的目录
    if (entry.isDirectory() && EXCLUDED_DIRS.includes(entry.name)) {
      console.log(`  ⏭️  Skipped (privacy): ${entry.name}/`);
      continue;
    }
    // 跳过排除的文件
    if (entry.isFile() && EXCLUDED_FILES.includes(entry.name)) {
      console.log(`  ⏭️  Skipped (privacy): ${entry.name}`);
      continue;
    }
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyResourcesFiltered(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyResourcesFiltered(RESOURCES_DIR, resourceDest);
console.log('  Copied: resources/ (filtered)');

// 创建便携版 zip
console.log('📦 Creating portable zip...');
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${portableDir}\\*' -DestinationPath '${DIST_DIR}\\Codex-Assistant-v${VERSION}-portable.zip' -Force"`,
  { stdio: 'ignore' }
);

console.log('✅ Portable package created\n');

// ==================== 完成 ====================
console.log('='.repeat(50));
console.log(`\n✨ Release build complete!`);
console.log(`\n📁 Output directory: ${DIST_DIR}\n`);

// 列出所有文件
const files = fs.readdirSync(DIST_DIR);
for (const file of files) {
  const filePath = path.join(DIST_DIR, file);
  const stat = fs.statSync(filePath);
  const size = (stat.size / 1024 / 1024).toFixed(2);
  console.log(`  ${file} (${size} MB)`);
}

console.log('\n');

// ==================== 辅助函数 ====================
function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
