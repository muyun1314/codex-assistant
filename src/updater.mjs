// ============================================================
// Codex Assistant — Auto Updater
// Checks GitHub Releases for new versions and handles updates
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFileCb);

// GitHub repo info - read from package.json
function getGithubRepoInfo() {
  try {
    var packagePath = path.join(process.cwd(), 'package.json');
    var packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
    var repoUrl = packageJson.repository && packageJson.repository.url || '';
    var match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.\s]+)/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  } catch (err) { /* fallback */ }
  return null;
}

var _repoInfo = getGithubRepoInfo();
var GITHUB_OWNER = _repoInfo ? _repoInfo.owner : '';
var GITHUB_REPO = _repoInfo ? _repoInfo.repo : '';
var GITHUB_API = GITHUB_OWNER ? 'https://api.github.com/repos/' + encodeURIComponent(GITHUB_OWNER) + '/' + encodeURIComponent(GITHUB_REPO) + '/releases/latest' : '';

// Version info
const VERSION_FILE = 'version.json';

/**
 * Get current version from version.json
 */
export function getCurrentVersion(projectDir) {
  try {
    const versionPath = path.join(projectDir, VERSION_FILE);
    if (!fs.existsSync(versionPath)) return { version: '0.0.0', build: 0 };
    return JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
  } catch {
    return { version: '0.0.0', build: 0 };
  }
}

/**
 * Save version info to version.json
 */
export function saveVersion(projectDir, versionInfo) {
  const versionPath = path.join(projectDir, VERSION_FILE);
  fs.writeFileSync(versionPath, JSON.stringify(versionInfo, null, 2));
}

/**
 * Compare two version strings (semver)
 * Returns: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
export function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

/**
 * Check GitHub for latest release
 * Returns: { version, downloadUrl, changelog, publishedAt } or null
 */
export async function checkForUpdates(currentVersion) {
  if (!GITHUB_API) {
    console.error('[updater] GitHub repo not configured in package.json');
    return null;
  }
  try {
    const response = await fetch(GITHUB_API, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Codex-Assistant-Updater/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const release = await response.json();
    
    // Extract version from tag (e.g., "v1.2.3" -> "1.2.3")
    const latestVersion = release.tag_name.replace(/^v/, '');
    
    // Find the main asset (zip file)
    const zipAsset = release.assets.find(a => 
      a.name.endsWith('.zip') && 
      (a.name.includes('codex-assistant') || a.name.includes('release'))
    );

    if (!zipAsset) {
      // No downloadable asset found
      return null;
    }

    return {
      version: latestVersion,
      downloadUrl: zipAsset.browser_download_url,
      fileName: zipAsset.name,
      changelog: release.body || 'No changelog provided',
      publishedAt: release.published_at,
      htmlUrl: release.html_url
    };
  } catch (err) {
    console.error('[updater] Failed to check for updates:', err.message);
    return null;
  }
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
