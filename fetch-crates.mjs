// Download all crate source files concurrently using Node.js TLS
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARGO_HOME = path.join(__dirname, '.cargo');
const CACHE_DIR = path.join(CARGO_HOME, 'registry', 'cache', 'tuna');
const SRC_DIR = path.join(CARGO_HOME, 'registry', 'src', 'tuna');
const CONCURRENCY = 8;

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

async function downloadOne(name, vers) {
  const crateFile = `${name}-${vers}.crate`;
  const cachePath = path.join(CACHE_DIR, crateFile);

  if (fs.existsSync(cachePath)) {
    return { name, vers, cached: true };
  }

  const urls = [
    `https://static.crates.io/crates/${name}/${crateFile}`,
    `https://mirrors.tuna.tsinghua.edu.cn/crates/${name}/${crateFile}`,
  ];

  for (const url of urls) {
    try {
      const data = await fetch(url);
      fs.writeFileSync(cachePath, data);
      return { name, vers, size: data.length };
    } catch (e) {
      // Try next URL
    }
  }
  return { name, vers, failed: true };
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(SRC_DIR, { recursive: true });

  // Read all index files to find exact versions
  const indexDir = path.join(CARGO_HOME, 'registry', 'index', 'tuna');
  const indexFiles = fs.readdirSync(indexDir).filter(f => f !== 'config.json');

  const crateVersions = new Map();
  for (const f of indexFiles) {
    const data = fs.readFileSync(path.join(indexDir, f), 'utf-8');
    const lines = data.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.vers && !entry.yanked) {
          if (!crateVersions.has(f)) {
            crateVersions.set(f, entry.vers);
          }
        }
      } catch {}
    }
  }

  const tasks = [...crateVersions.entries()].map(([name, vers]) => ({ name, vers }));
  console.log(`📦 Downloading ${tasks.length} crates (concurrency: ${CONCURRENCY})...\n`);

  let success = 0, fail = 0, cached = 0;
  const results = [];

  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(t => downloadOne(t.name, t.vers)));
    for (const r of batchResults) {
      if (r.cached) {
        cached++;
      } else if (r.failed) {
        console.log(`❌ ${r.name}-${r.vers}`);
        fail++;
      } else {
        console.log(`✅ ${r.name}-${r.vers} (${(r.size / 1024).toFixed(0)} KB)`);
        success++;
      }
    }
  }

  console.log(`\n✅ Downloaded: ${success}, 📦 Cached: ${cached}, ❌ Failed: ${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
