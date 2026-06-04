// Setup: configure Cargo to use local file:// registry
// Place crate files in the correct directory structure for Cargo's cache
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARGO_HOME = path.join(__dirname, '.cargo');
const CACHE_DIR = path.join(CARGO_HOME, 'registry', 'cache', 'tuna');
const INDEX_DIR = path.join(CARGO_HOME, 'registry', 'index', 'tuna');

fs.mkdirSync(CACHE_DIR, { recursive: true });

// Read all index files to find exact versions
const indexFiles = fs.readdirSync(INDEX_DIR).filter(f => f !== 'config.json');
const crateVersions = new Map();

for (const f of indexFiles) {
  const data = fs.readFileSync(path.join(INDEX_DIR, f), 'utf-8');
  const lines = data.split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.vers && !entry.yanked && !crateVersions.has(f)) {
        crateVersions.set(f, entry.vers);
      }
    } catch {}
  }
}

// Copy crate files to Cargo's expected cache directory
// Cargo expects: $CARGO_HOME/registry/src/<registry>/<crate>-<version>.crate
const SRC_DIR = path.join(CARGO_HOME, 'registry', 'src', 'tuna');
fs.mkdirSync(SRC_DIR, { recursive: true });

let count = 0;
for (const [name, vers] of crateVersions) {
  const crateFile = `${name}-${vers}.crate`;
  const srcPath = path.join(SRC_DIR, crateFile);
  if (!fs.existsSync(srcPath)) {
    // Check if it's already in the right place
    const existing = fs.readdirSync(SRC_DIR).find(f => f === crateFile);
    if (!existing) {
      console.log(`❌ Missing: ${crateFile}`);
      continue;
    }
  }
  count++;
}

console.log(`✅ ${count} crate files in ${SRC_DIR}`);

// Update config.json to use file:// for downloads
// Cargo's file:// download: file://<path>/{crate}/{version}/{crate}-{version}.crate
const configPath = path.join(INDEX_DIR, 'config.json');
const config = {
  "dl": `file://${CARGO_HOME}/registry/src/tuna/{crate}/{version}/{crate}-{version}.crate`,
  "api": null
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('✅ Updated config.json with file:// download URL');
console.log(`   dl: ${config.dl}`);
