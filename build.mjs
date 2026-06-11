// Build tauri debug
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tauriBin = path.join(__dirname, 'node_modules', '.bin', 'tauri');

const env = {
  ...process.env,
  CARGO_HOME: path.join(__dirname, '.cargo'),
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};

console.log('🔨 Starting Tauri debug build...');
console.log('   CARGO_HOME:', env.CARGO_HOME);
console.log('   tauri:', tauriBin);

try {
  execSync(`"${tauriBin}" build --debug`, {
    cwd: __dirname,
    stdio: 'inherit',
    env,
    timeout: 600000,
    shell: true,
  });
  console.log('\n✅ Build complete!');
} catch (e) {
  console.error('\n❌ Build failed');
  process.exit(1);
}
