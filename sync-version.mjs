#!/usr/bin/env node
// ============================================================
// 版本号同步脚本
// 从 version.json 读取版本号，同步到所有需要版本号的文件
//
// 版本号管理规则：
//   - 唯一源头：version.json
//   - 同步目标：package.json, Cargo.toml, tauri.conf.json, resources/version.json
//   - 修改版本号：只修改 version.json，然后运行 node sync-version.mjs
//   - 构建时自动同步：npm run tauri:build 会自动先同步版本号
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取 version.json（唯一的版本号源头）
const versionPath = path.join(__dirname, 'version.json');
if (!fs.existsSync(versionPath)) {
  console.error('❌ version.json not found');
  process.exit(1);
}

const versionInfo = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
const version = versionInfo.version;

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('❌ Invalid version format in version.json:', version);
  process.exit(1);
}

console.log(`📦 Syncing version: ${version}\n`);

let updated = 0;

// 1. 同步 package.json
const packagePath = path.join(__dirname, 'package.json');
if (fs.existsSync(packagePath)) {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
  if (packageJson.version !== version) {
    packageJson.version = version;
    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
    console.log(`✅ package.json: ${version}`);
    updated++;
  } else {
    console.log(`⏭️  package.json: already ${version}`);
  }
}

// 2. 同步 src-tauri/Cargo.toml
const cargoPath = path.join(__dirname, 'src-tauri', 'Cargo.toml');
if (fs.existsSync(cargoPath)) {
  let cargoContent = fs.readFileSync(cargoPath, 'utf-8');
  const versionRegex = /^(version\s*=\s*)"[^"]+"/m;
  const match = cargoContent.match(versionRegex);
  if (match) {
    const currentVersion = match[1].replace(/^version\s*=\s*"|"/g, '');
    if (currentVersion !== version) {
      cargoContent = cargoContent.replace(versionRegex, `$1"${version}"`);
      fs.writeFileSync(cargoPath, cargoContent);
      console.log(`✅ Cargo.toml: ${version}`);
      updated++;
    } else {
      console.log(`⏭️  Cargo.toml: already ${version}`);
    }
  }
}

// 3. 同步 src-tauri/tauri.conf.json
const tauriConfPath = path.join(__dirname, 'src-tauri', 'tauri.conf.json');
if (fs.existsSync(tauriConfPath)) {
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf-8'));
  if (tauriConf.version !== version) {
    tauriConf.version = version;
    fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
    console.log(`✅ tauri.conf.json: ${version}`);
    updated++;
  } else {
    console.log(`⏭️  tauri.conf.json: already ${version}`);
  }
}

// 4. 同步 src-tauri/resources/version.json
const resourcesVersionPath = path.join(__dirname, 'src-tauri', 'resources', 'version.json');
if (fs.existsSync(resourcesVersionPath)) {
  const resourcesVersion = JSON.parse(fs.readFileSync(resourcesVersionPath, 'utf-8'));
  if (resourcesVersion.version !== version) {
    resourcesVersion.version = version;
    resourcesVersion.releasedAt = versionInfo.releasedAt || new Date().toISOString().split('T')[0];
    fs.writeFileSync(resourcesVersionPath, JSON.stringify(resourcesVersion, null, 2) + '\n');
    console.log(`✅ resources/version.json: ${version}`);
    updated++;
  } else {
    console.log(`⏭️  resources/version.json: already ${version}`);
  }
}

console.log(`\n✨ Done! ${updated} file(s) updated.`);
