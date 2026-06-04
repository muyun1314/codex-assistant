// Cargo sparse index HTTP server
// Cargo fetches: GET /config.json, GET /XX/YY/crate-name
// The server needs to support HTTP range requests and proper content-type headers
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_DIR = path.join(__dirname, '.cargo', 'registry', 'index', 'tuna');
const PORT = 18888;

// Read all index files into memory
const files = new Map();
const indexFiles = fs.readdirSync(INDEX_DIR);
for (const f of indexFiles) {
  const data = fs.readFileSync(path.join(INDEX_DIR, f));
  files.set('/' + f, data);
  // Also map sparse index paths
  if (f !== 'config.json') {
    const len = f.length;
    if (len <= 2) {
      files.set(`/${len}/${f}`, data);
    } else if (len === 3) {
      files.set(`/${f.substring(0, 2)}/${f}`, data);
    } else {
      files.set(`/${f.substring(0, 2)}/${f.substring(2, 4)}/${f}`, data);
    }
  }
}

console.log(`📦 Loaded ${files.size} files into memory`);

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  
  if (urlPath === '/config.json' || urlPath.endsWith('/config.json')) {
    const data = files.get('/config.json');
    if (data) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
      });
      res.end(data);
      return;
    }
  }
  
  const data = files.get(urlPath);
  if (data) {
    // Support range requests
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : data.length - 1;
      const chunk = data.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${data.length}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': chunk.length,
      });
      res.end(chunk);
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(data);
    }
    console.log(`  ${urlPath} -> ${data.length} bytes`);
  } else {
    res.writeHead(404);
    res.end('Not found');
    console.log(`  ${urlPath} -> 404`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 Cargo registry mirror running at http://127.0.0.1:${PORT}`);
  console.log(`   Serving ${files.size} files`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
