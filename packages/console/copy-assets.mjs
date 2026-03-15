import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Copy .output/public/* to dist/ after vite build
cpSync(
  join(__dirname, '.output/public'),
  join(__dirname, 'dist'),
  { recursive: true, force: true }
);

console.log('✅ Copied static assets from .output/public to dist/');
