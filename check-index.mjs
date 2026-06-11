// Check the correct sparse index path format for Tuna mirror
import https from 'https';

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'nodejs' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

async function main() {
  // Tuna sparse index format: /<first 2 chars>/<next 2 chars>/<name>
  // For "tauri" (5 chars): /ta/ur/tauri
  // For "tauri-build" (11 chars): /ta/ur/tauri-build
  // For "tauri-plugin-shell" (18 chars): /ta/ur/tauri-plugin-shell
  
  const testPaths = [
    'https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/ta/ur/tauri',
    'https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/ta/ur/tauri-build',
    'https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/ta/ur/tauri-plugin-shell',
    // Also check config.json
    'https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/config.json',
  ];
  
  for (const url of testPaths) {
    try {
      const { status, data } = await fetch(url);
      console.log(`${status} ${url} (${data.length} bytes)`);
      if (status === 200) {
        console.log(`  Preview: ${data.toString('utf-8').substring(0, 200)}`);
      }
    } catch (e) {
      console.log(`ERR ${url}: ${e.message}`);
    }
  }
}

main();
