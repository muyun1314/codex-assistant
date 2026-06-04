// Download crate indexes with correct Tuna sparse index path format
// Tuna mirror uses: /<first 2 chars>/<next 2 chars>/<name> for names >= 4 chars
// For names < 4 chars: /<len>/<name>
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_DIR = path.join(__dirname, '.cargo', 'registry', 'index', 'tuna');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'nodejs' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function getSparsePath(name) {
  // Tuna sparse index path format (same as crates.io)
  if (name.length <= 2) {
    return `/${name.length}/${name}`;
  } else if (name.length === 3) {
    return `/${name.substring(0, 2)}/${name}`;
  } else {
    return `/${name.substring(0, 2)}/${name.substring(2, 4)}/${name}`;
  }
}

async function downloadCrateIndex(name) {
  const subPath = getSparsePath(name);
  const url = `https://mirrors.tuna.tsinghua.edu.cn/crates.io-index${subPath}`;
  try {
    const data = await fetch(url);
    fs.writeFileSync(path.join(INDEX_DIR, name), data);
    console.log(`✅ ${name} (${data.length} bytes) [${subPath}]`);
    return data;
  } catch (e) {
    console.log(`❌ ${name}: ${e.message} [${subPath}]`);
    return null;
  }
}

async function main() {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  
  // Download config.json
  const config = await fetch('https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/config.json');
  fs.writeFileSync(path.join(INDEX_DIR, 'config.json'), config);
  console.log('✅ config.json\n');
  
  // Get all deps from tauri 2.x index
  const tauriIndex = fs.readFileSync(path.join(INDEX_DIR, 'tauri'), 'utf-8');
  const lines = tauriIndex.split('\n').filter(l => l.trim());
  
  let allDeps = new Set();
  for (const line of [...lines].reverse()) {
    try {
      const entry = JSON.parse(line);
      if (entry.vers && entry.vers.startsWith('2.') && !entry.yanked && entry.deps) {
        for (const dep of entry.deps) {
          if (dep.kind === 'normal') allDeps.add(dep.name);
        }
        break;
      }
    } catch {}
  }
  
  // Also get deps from tauri-build and tauri-plugin-shell
  for (const crateName of ['tauri-build', 'tauri-plugin-shell']) {
    const idx = fs.readFileSync(path.join(INDEX_DIR, crateName), 'utf-8');
    const idxLines = idx.split('\n').filter(l => l.trim());
    for (const line of [...idxLines].reverse()) {
      try {
        const entry = JSON.parse(line);
        if (entry.vers && !entry.yanked && entry.deps) {
          for (const dep of entry.deps) {
            if (dep.kind === 'normal') allDeps.add(dep.name);
          }
          break;
        }
      } catch {}
    }
  }
  
  console.log(`📦 Total unique dependencies: ${allDeps.size}\n`);
  
  // Download all dep indexes
  let success = 0, fail = 0;
  for (const dep of allDeps) {
    const data = await downloadCrateIndex(dep);
    if (data) success++;
    else fail++;
  }
  
  console.log(`\n✅ Downloaded: ${success}, ❌ Failed: ${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
