// Download ALL crate files - fixed version with proper redirect handling
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARGO_HOME = path.join(__dirname, '.cargo');
const INDEX_DIR = path.join(CARGO_HOME, 'registry', 'index', 'tuna');
const SRC_DIR = path.join(CARGO_HOME, 'registry', 'src', 'tuna');
const CONCURRENCY = 16;

function fetch(url, depth) {
  depth = depth || 0;
  if (depth > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'nodejs' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) {
          const origin = new URL(url).origin;
          loc = origin + loc;
        }
        res.resume();
        return fetch(loc, depth + 1).then(resolve).catch(reject);
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

function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0, vb = pb[i] || 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

async function main() {
  fs.mkdirSync(SRC_DIR, { recursive: true });

  // Parse all indexes to find the LATEST non-yanked version
  const indexFiles = fs.readdirSync(INDEX_DIR).filter(f => f !== 'config.json');
  const latestVersions = new Map();

  for (const f of indexFiles) {
    const data = fs.readFileSync(path.join(INDEX_DIR, f), 'utf-8');
    const lines = data.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.vers && !entry.yanked) {
          const existing = latestVersions.get(f);
          if (!existing || semverCompare(entry.vers, existing.vers) > 0) {
            latestVersions.set(f, { vers: entry.vers, cksum: entry.cksum });
          }
        }
      } catch {}
    }
  }

  console.log(`📦 ${latestVersions.size} crates\n`);

  const tasks = [...latestVersions.entries()];
  let success = 0, fail = 0, skipped = 0;

  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async ([name, info]) => {
      const crateFile = `${name}-${info.vers}.crate`;
      const srcPath = path.join(SRC_DIR, crateFile);

      // Skip if already downloaded and size > 10KB
      if (fs.existsSync(srcPath) && fs.statSync(srcPath).size > 10000) {
        return { name, vers: info.vers, cached: true };
      }

      const url = `https://static.crates.io/crates/${name}/${crateFile}`;
      try {
        const data = await fetch(url);
        fs.writeFileSync(srcPath, data);
        return { name, vers: info.vers, size: data.length };
      } catch (e) {
        return { name, vers: info.vers, failed: true, error: e.message };
      }
    }));

    for (const r of results) {
      if (r.cached) skipped++;
      else if (r.failed) {
        console.log(`❌ ${r.name}-${r.vers}: ${r.error}`);
        fail++;
      } else {
        success++;
      }
    }

    const done = Math.min(i + CONCURRENCY, tasks.length);
    process.stdout.write(`\r  Progress: ${done}/${tasks.length} (ok:${success} skip:${skipped} fail:${fail})`);
  }

  console.log(`\n\n✅ Downloaded: ${success}, 📦 Cached: ${skipped}, ❌ Failed: ${fail}`);

  // Verify key files
  console.log('\nKey crates:');
  for (const name of ['tauri', 'tokio', 'serde', 'tauri-plugin-shell', 'tauri-build', 'windows']) {
    const info = latestVersions.get(name);
    if (info) {
      const p = path.join(SRC_DIR, `${name}-${info.vers}.crate`);
      const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
      console.log(`  ${name}-${info.vers}: ${(size / 1024).toFixed(0)} KB`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
