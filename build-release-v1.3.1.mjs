#!/usr/bin/env node
// ============================================================
// Codex Assistant v1.3.1 发布打包脚本
// 生成：便携版、NSIS安装版
// 保存位置：F:\WorkSpace\codex-assistant-v1.3\dist
// 注意：保留已有的 v1.3.0 版本文件
// ============================================================

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取版本号
const versionInfo = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf-8'));
const VERSION = versionInfo.version;

const DIST_DIR = path.join(__dirname, 'dist');
const RELEASE_DIR = path.join(__dirname, 'src-tauri', 'target', 'release');
const RESOURCES_DIR = path.join(__dirname, 'src-tauri', 'resources');

console.log(`\n📦 Building Codex Assistant v${VERSION}\n`);

// 只清理新版本的文件，保留旧版本
const filesToClean = [
  `Codex-Assistant-v${VERSION}-setup.exe`,
  `Codex-Assistant-v${VERSION}-portable.zip`,
  `Codex-Assistant-v${VERSION}-portable`
];

for (const file of filesToClean) {
  const filePath = path.join(DIST_DIR, file);
  if (fs.existsSync(filePath)) {
    try {
      if (fs.statSync(filePath).isDirectory()) {
        fs.rmSync(filePath, { recursive: true });
      } else {
        fs.unlinkSync(filePath);
      }
      console.log(`🗑️  Removed: ${file}`);
    } catch (e) { /* ignore */ }
  }
}

// ==================== 安装版 ====================
// 先进行 Tauri release build（耗时较长，生成 NSIS + MSI）
console.log('\n📦 Building installer packages (Tauri release build)...\n');

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

// 复制版本和许可证文件
fs.copyFileSync(path.join(__dirname, 'version.json'), path.join(portableDir, 'version.json'));
fs.copyFileSync(path.join(__dirname, 'LICENSE'), path.join(portableDir, 'LICENSE'));

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
  if (stat.isFile()) {
    const size = (stat.size / 1024 / 1024).toFixed(2);
    console.log(`  ${file} (${size} MB)`);
  } else {
    console.log(`  ${file}/ (directory)`);
  }
}

console.log('\n');
