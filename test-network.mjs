// Minimal script: just test that Node.js TLS can reach Tuna mirror
import https from 'https';

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'nodejs' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

async function main() {
  // Check if we can reach the Tuna mirror
  const r = await fetch('https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/config.json');
  console.log(`Tuna mirror: HTTP ${r.status}, ${r.data.length} bytes`);
  console.log(r.data.toString());
  
  // Check if we can reach static.crates.io
  const r2 = await fetch('https://static.crates.io/crates/tauri/tauri-2.4.0.crate');
  console.log(`static.crates.io: HTTP ${r2.status}, ${r2.data.length} bytes`);
}

main();
