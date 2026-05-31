// wix-proxy.mjs - Download WiX from GitHub mirrors with progress display
// Usage: node wix-proxy.mjs
// Downloads WiX toolset to Tauri cache directory if not already present.

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

const WIX_DIR = path.join(process.env.LOCALAPPDATA || '', 'tauri', 'Wix');
const WIX_ZIP = path.join(WIX_DIR, 'wix314-binaries.zip');
const WIX_EXE = path.join(WIX_DIR, 'candle.exe');

const GITHUB_URL = 'https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip';

const MIRRORS = [
  { name: 'ghfast.top',        url: 'https://ghfast.top/https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip' },
  { name: 'ghproxy.cn',        url: 'https://ghproxy.cn/https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip' },
  { name: 'mirror.ghproxy.com', url: 'https://mirror.ghproxy.com/https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip' },
];

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) return bytesPerSec + ' B/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
  return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
}

function downloadWithProgress(url, destPath, label) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const startTime = Date.now();

    const doRequest = (requestUrl, redirectCount) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const req = mod.get(requestUrl, { timeout: 30000 }, (res) => {
        // Handle redirects
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          const location = res.headers.location;
          if (location) {
            const nextMod = location.startsWith('https') ? https : http;
            doRequest(location, redirectCount + 1);
            return;
          }
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const totalSize = parseInt(res.headers['content-length'], 10) || 0;
        let downloaded = 0;
        let lastReport = 0;

        const ws = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          const now = Date.now();
          // Update progress every 2 seconds (one line per update)
          if (now - lastReport > 2000) {
            lastReport = now;
            const elapsed = (now - startTime) / 1000;
            const speed = downloaded / elapsed;
            const pct = totalSize > 0 ? ((downloaded / totalSize) * 100).toFixed(1) : '?';
            console.log(`  [${label}] ${formatBytes(downloaded)} / ${formatBytes(totalSize)} (${pct}%) ${formatSpeed(speed)}`);
          }
        });

        res.pipe(ws);

        ws.on('finish', () => {
          ws.close();
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = downloaded / elapsed;
          console.log(`  [${label}] Done: ${formatBytes(downloaded)} in ${elapsed.toFixed(1)}s (${formatSpeed(speed)})`);
          resolve(true);
        });

        ws.on('error', (e) => {
          try { fs.unlinkSync(destPath); } catch {}
          reject(e);
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Connection timeout'));
      });
    };

    doRequest(url, 0);
  });
}

async function main() {
  // Check if already cached
  if (fs.existsSync(WIX_EXE)) {
    console.log('[wix] Already cached at:', WIX_DIR);
    console.log('[wix] OK');
    return;
  }

  console.log('[wix] WiX Toolset not found, downloading...');
  console.log('[wix] Cache dir:', WIX_DIR);
  console.log('');
  fs.mkdirSync(WIX_DIR, { recursive: true });

  // Try GitHub directly first (with progress)
  console.log('  [1] Trying GitHub...');
  try {
    await downloadWithProgress(GITHUB_URL, WIX_ZIP, 'GitHub');
  } catch (e) {
    console.log(`  [1] Failed: ${e.message}`);
    console.log('');

    // Try mirrors
    for (let i = 0; i < MIRRORS.length; i++) {
      const m = MIRRORS[i];
      console.log(`  [${i + 2}] Trying ${m.name}...`);
      try {
        await downloadWithProgress(m.url, WIX_ZIP, m.name);
        break; // Success
      } catch (e2) {
        console.log(`  [${i + 2}] Failed: ${e2.message}`);
        console.log('');
      }
    }
  }

  // Verify download
  if (!fs.existsSync(WIX_ZIP) || fs.statSync(WIX_ZIP).size < 10000000) {
    console.error('');
    console.error('[wix] ERROR: Download failed from all sources!');
    console.error('[wix] Please download manually:');
    console.error('  ', GITHUB_URL);
    console.error('[wix] And extract to:', WIX_DIR);
    process.exit(1);
  }

  // Extract
  console.log('');
  console.log('[wix] Extracting...');
  const { execSync } = await import('child_process');
  try {
    execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${WIX_ZIP}' -DestinationPath '${WIX_DIR}' -Force"`, {
      stdio: 'inherit'
    });
  } catch (e) {
    console.error('[wix] ERROR: Extraction failed!');
    process.exit(1);
  }

  // Clean up zip
  try { fs.unlinkSync(WIX_ZIP); } catch {}

  console.log('[wix] Installed to:', WIX_DIR);
  console.log('[wix] OK');
}

main().catch((e) => {
  console.error('[wix] Fatal error:', e.message);
  process.exit(1);
});
