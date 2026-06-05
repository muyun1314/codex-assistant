// ============================================================
// Codex Assistant — Auto Updater
// Checks GitHub Releases for new versions and handles updates
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
var require = createRequire(import.meta.url);
const execFileAsync = promisify(execFileCb);

// ---- Proxy support (Node.js fetch doesn't use system proxy by default) ----

var _proxyAgent = null;

// Read Windows system proxy settings (the one browsers use)
function getWindowsSystemProxy() {
  if (process.platform !== 'win32') return null;
  try {
    var result = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyEnable'
    ], { encoding: 'utf8', windowsHide: true });
    if (!result || result.indexOf('0x1') === -1) return null;

    var serverResult = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyServer'
    ], { encoding: 'utf8', windowsHide: true });
    var match = serverResult && serverResult.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (match && match[1]) {
      var server = match[1].trim();
      // Add http:// prefix if missing
      if (!/^https?:\/\//i.test(server)) server = 'http://' + server;
      return server;
    }
  } catch (e) { /* not configured */ }
  return null;
}

function getProxyAgent() {
  if (_proxyAgent !== null) return _proxyAgent;

  // 1) Environment variables (manual override)
  var proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy ||
                 process.env.HTTP_PROXY  || process.env.http_proxy ||
                 process.env.ALL_PROXY   || process.env.all_proxy || '';

  // 2) Windows system proxy (same one the browser uses)
  if (!proxyUrl.trim()) {
    var sysProxy = getWindowsSystemProxy();
    if (sysProxy) {
      proxyUrl = sysProxy;
      console.log('[updater] Detected Windows system proxy:', proxyUrl);
    }
  }

  proxyUrl = proxyUrl.trim();
  if (!proxyUrl) { _proxyAgent = false; return null; }

  try {
    var undici = require('undici');
    var ProxyAgent = undici.ProxyAgent;
    _proxyAgent = new ProxyAgent(proxyUrl);
    console.log('[updater] Using proxy:', proxyUrl);
  } catch (e) {
    console.warn('[updater] Proxy URL found but undici ProxyAgent unavailable:', e.message);
    _proxyAgent = false;
  }
  return _proxyAgent === false ? null : _proxyAgent;
}

// GitHub repo info — hardcoded defaults for portable builds
var GITHUB_OWNER = 'muyun1314';
var GITHUB_REPO = 'codex-assistant';
var GITHUB_RELEASES_API = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/releases/latest';
var GITHUB_RELEASES_PAGE = 'https://github.com/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/releases/latest';
var FETCH_TIMEOUT_MS = 15000; // 15s timeout per request

// Try to read repo info from package.json, but hardcoded fallback is authoritative
function initRepoInfo() {
  try {
    var packagePath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(packagePath)) {
      var pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      var repoUrl = (pkg.repository && pkg.repository.url) || '';
      var match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.\s]+)/);
      if (match) {
        GITHUB_OWNER = match[1];
        GITHUB_REPO = match[2];
        GITHUB_RELEASES_API = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/releases/latest';
        GITHUB_RELEASES_PAGE = 'https://github.com/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/releases/latest';
      }
    }
  } catch (e) { /* use hardcoded defaults */ }
}
initRepoInfo();

// Version info
var VERSION_FILE = 'version.json';

/**
 * Get current version from version.json
 */
export function getCurrentVersion(projectDir) {
  try {
    var versionPath = path.join(projectDir, VERSION_FILE);
    if (!fs.existsSync(versionPath)) return { version: '0.0.0', build: 0 };
    return JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
  } catch (e) {
    return { version: '0.0.0', build: 0 };
  }
}

/**
 * Save version info to version.json
 */
export function saveVersion(projectDir, versionInfo) {
  var versionPath = path.join(projectDir, VERSION_FILE);
  fs.writeFileSync(versionPath, JSON.stringify(versionInfo, null, 2));
}

/**
 * Compare two version strings (semver)
 * Returns: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
export function compareVersions(v1, v2) {
  var parts1 = v1.split('.').map(Number);
  var parts2 = v2.split('.').map(Number);

  for (var i = 0; i < 3; i++) {
    var p1 = parts1[i] || 0;
    var p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

/**
 * Fetch with timeout
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    var opts = Object.assign({ signal: controller.signal }, options);
    var proxy = getProxyAgent();
    if (proxy) { opts.dispatcher = proxy; }
    var response = await fetch(url, opts);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check GitHub API for latest release.
 * Returns { version, downloadUrl, changelog, ... } on success,
 * or { error: 'message' } on failure.
 */
export async function checkForUpdatesViaApi() {
  try {
    var response = await fetchWithTimeout(GITHUB_RELEASES_API, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Codex-Assistant-Updater/1.0'
      }
    }, FETCH_TIMEOUT_MS);

    if (!response.ok) {
      var rateLimit = response.headers.get('x-ratelimit-remaining');
      if (response.status === 403 && rateLimit === '0') {
        return { error: 'GitHub API 频率限制，请稍后再试（60次/小时）' };
      }
      if (response.status === 404) {
        return { error: '未找到发布版本，请检查仓库: ' + GITHUB_OWNER + '/' + GITHUB_REPO };
      }
      return { error: 'GitHub API 返回错误 HTTP ' + response.status };
    }

    var release = await response.json();

    // Extract version from tag (e.g., "v1.2.3" → "1.2.3")
    var tagName = release.tag_name || '';
    var latestVersion = tagName.replace(/^v/, '');

    if (!latestVersion) {
      return { error: '无法解析 GitHub 发布标签版本号' };
    }

    // Find zip asset — case-insensitive match
    var zipAsset = null;
    if (release.assets && release.assets.length > 0) {
      zipAsset = release.assets.find(function(a) {
        var name = (a.name || '').toLowerCase();
        return name.endsWith('.zip') && (name.indexOf('codex-assistant') !== -1 || name.indexOf('portable') !== -1);
      });
    }

    // Even without a matched zip, we can still report the version
    return {
      version: latestVersion,
      downloadUrl: zipAsset ? zipAsset.browser_download_url : null,
      fileName: zipAsset ? zipAsset.name : null,
      changelog: release.body || '',
      publishedAt: release.published_at || '',
      htmlUrl: release.html_url || GITHUB_RELEASES_PAGE,
      hasAsset: !!zipAsset
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: '连接 GitHub 超时（15s）。如使用了代理，请设置环境变量 HTTPS_PROXY' };
    }
    if (err.cause && err.cause.code === 'ENOTFOUND') {
      return { error: '无法解析 GitHub 域名（DNS 失败），请检查网络或设置 HTTPS_PROXY 代理' };
    }
    return { error: '连接 GitHub API 失败：' + (err.message || '未知错误') + '。如使用了代理，请在系统环境变量中设置 HTTPS_PROXY' };
  }
}

/**
 * Fallback: scrape the GitHub releases page for the latest version tag.
 * Used when the API is unreachable.
 */
export async function checkForUpdatesViaPage() {
  try {
    var response = await fetchWithTimeout(GITHUB_RELEASES_PAGE, {
      headers: { 'User-Agent': 'Codex-Assistant-Updater/1.0' },
      redirect: 'follow'
    }, FETCH_TIMEOUT_MS);

    if (!response.ok) {
      return { error: 'GitHub Releases 页面返回 HTTP ' + response.status };
    }

    var html = await response.text();

    // Look for the first version tag in the page
    // GitHub renders tags like: /releases/tag/v1.2.6  or  <span class="css-truncate">v1.2.6</span>
    var tagMatch = html.match(/\/releases\/tag\/(v?\d+\.\d+\.\d+)/);
    if (!tagMatch) {
      // Try alternative pattern: the <title> tag often contains the latest version
      var titleMatch = html.match(/<title>.*?(v?\d+\.\d+\.\d+).*?<\/title>/);
      if (titleMatch) {
        return {
          version: titleMatch[1].replace(/^v/, ''),
          htmlUrl: GITHUB_RELEASES_PAGE,
          _source: 'page-title'
        };
      }
      return { error: '无法从页面解析版本号' };
    }

    return {
      version: tagMatch[1].replace(/^v/, ''),
      htmlUrl: GITHUB_RELEASES_PAGE,
      _source: 'page-scrape'
    };
  } catch (err) {
    return { error: '连接 GitHub 页面失败：' + (err.message || '未知错误') + '。请检查网络或设置 HTTPS_PROXY 环境变量' };
  }
}

/**
 * Check for updates — tries API first, falls back to page scraping.
 * Returns { version, ... } on success, { error: '...' } on failure.
 */
export async function checkForUpdates() {
  // Strategy 1: GitHub API (rich info: changelog, assets, etc.)
  var result = await checkForUpdatesViaApi();
  if (!result.error && result.version) {
    return result;
  }
  var apiError = result.error;

  // Strategy 2: Scrape the releases page (version only)
  console.warn('[updater] API check failed (' + apiError + '), trying page scrape...');
  result = await checkForUpdatesViaPage();
  if (!result.error && result.version) {
    result._apiError = apiError;
    return result;
  }

  // Both failed
  return { error: apiError + '；页面抓取也失败：' + result.error };
}


/**
 * Download file with progress callback
 */
export async function downloadFile(url, destPath, onProgress) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Codex-Assistant-Updater/1.0' }
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const totalSize = parseInt(response.headers.get('content-length') || '0');
  let downloadedSize = 0;

  const fileStream = fs.createWriteStream(destPath);
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      fileStream.write(value);
      downloadedSize += value.length;

      if (onProgress && totalSize > 0) {
        onProgress({
          downloaded: downloadedSize,
          total: totalSize,
          percent: Math.round((downloadedSize / totalSize) * 100)
        });
      }
    }
  } finally {
    fileStream.end();
    reader.releaseLock();
  }

  return destPath;
}

/**
 * Extract zip file
 */
export async function extractZip(zipPath, destDir) {
  // Use PowerShell on Windows, unzip on Linux/Mac
  if (process.platform === 'win32') {
    // Use -ArgumentList to avoid command injection via path traversal
    await execFileAsync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive',
      '-LiteralPath',
      zipPath,
      '-DestinationPath',
      destDir,
      '-Force'
    ]);
  } else {
    await execFileAsync('unzip', ['-o', zipPath, '-d', destDir]);
  }
}

/**
 * Apply update from downloaded zip
 * This is a simplified version - in production, you'd want:
 * 1. Backup current version
 * 2. Verify checksum
 * 3. Graceful shutdown of running processes
 * 4. Replace files
 * 5. Restart
 */
export async function applyUpdate(projectDir, zipPath, options = {}) {
  const { backupDir, log } = options;
  
  // 1. Create backup
  if (backupDir) {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    // Backup critical files
    const filesToBackup = ['user', 'package.json', 'version.json'];
    for (const file of filesToBackup) {
      const src = path.join(projectDir, file);
      const dest = path.join(backupDir, file);
      if (fs.existsSync(src)) {
        if (fs.statSync(src).isDirectory()) {
          fs.cpSync(src, dest, { recursive: true });
        } else {
          fs.copyFileSync(src, dest);
        }
      }
    }
    if (log) log.info('[updater] Backup created at', backupDir);
  }

  // 2. Extract to temp directory
  const tempDir = path.join(projectDir, '.update-temp');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    await extractZip(zipPath, tempDir);
    if (log) log.info('[updater] Extracted update to temp directory');

    // 3. Find the actual content directory (might be nested)
    let sourceDir = tempDir;
    const entries = fs.readdirSync(tempDir);
    if (entries.length === 1 && fs.statSync(path.join(tempDir, entries[0])).isDirectory()) {
      sourceDir = path.join(tempDir, entries[0]);
    }

    // 4. Copy new files (preserving user folder)
    const userDir = path.join(projectDir, 'user');
    const preserveDirs = ['user', 'node_modules', '.git', '.update-temp', '.update-backup'];
    
    for (const entry of fs.readdirSync(sourceDir)) {
      if (preserveDirs.includes(entry)) continue;
      
      const srcPath = path.join(sourceDir, entry);
      const destPath = path.join(projectDir, entry);
      
      if (fs.existsSync(destPath)) {
        if (fs.statSync(destPath).isDirectory()) {
          fs.rmSync(destPath, { recursive: true });
        }
      }
      
      if (fs.statSync(srcPath).isDirectory()) {
        fs.cpSync(srcPath, destPath, { recursive: true });
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }

    if (log) log.info('[updater] Update files applied successfully');

    // 5. Clean up temp directory
    fs.rmSync(tempDir, { recursive: true });
    
    // 6. Delete downloaded zip
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    return true;
  } catch (err) {
    // Clean up on error
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    throw err;
  }
}

/**
 * Rollback to backup
 */
export async function rollback(projectDir, backupDir) {
  if (!fs.existsSync(backupDir)) {
    throw new Error('Backup directory not found');
  }

  const filesToRestore = ['package.json', 'version.json'];
  for (const file of filesToRestore) {
    const src = path.join(backupDir, file);
    const dest = path.join(projectDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }

  // Restore user folder if it was backed up
  const userBackup = path.join(backupDir, 'user');
  if (fs.existsSync(userBackup)) {
    const userDir = path.join(projectDir, 'user');
    fs.cpSync(userBackup, userDir, { recursive: true });
  }
}
