// Download Tuna sparse index files to a local directory for Cargo to use
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARGO_HOME = path.join(__dirname, '.cargo');
const INDEX_DIR = path.join(CARGO_HOME, 'registry', 'index', 'tuna');

const CRATES = ['tauri', 'tauri-build', 'tauri-plugin-shell'];

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

async function main() {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  
  // Download config.json
  const config = await fetch('https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/config.json');
  fs.writeFileSync(path.join(INDEX_DIR, 'config.json'), config);
  console.log('✅ config.json');
  
  // Download sparse index for each crate
  for (const name of CRATES) {
    const url = `https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/ta/ur/${name}`;
    const data = await fetch(url);
    fs.writeFileSync(path.join(INDEX_DIR, name), data);
    console.log(`✅ ${name} index (${data.length} bytes)`);
  }
  
  console.log('\n✨ Index files ready at:', INDEX_DIR);
}

main().catch(e => { console.error(e); process.exit(1); });
