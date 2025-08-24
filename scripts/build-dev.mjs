#!/usr/bin/env node
import { spawn } from 'child_process';
import chokidar from 'chokidar';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

let buildProcess = null;
let buildQueue = false;

const runBuild = () => {
  if (buildProcess) {
    console.log('⏳ Build already running, queuing next build...');
    buildQueue = true;
    return;
  }

  console.log('🔨 Starting build...');
  buildProcess = spawn('pnpm', ['-w', 'build'], {
    stdio: 'inherit',
    cwd: rootDir,
  });

  buildProcess.on('close', (code) => {
    buildProcess = null;
    if (code === 0) {
      console.log('✅ Build completed successfully');
    } else {
      console.log(`❌ Build failed with exit code ${code}`);
    }

    if (buildQueue) {
      buildQueue = false;
      console.log('🔄 Running queued build...');
      setTimeout(runBuild, 100);
    }
  });

  buildProcess.on('error', (error) => {
    console.error('❌ Build process error:', error);
    buildProcess = null;
  });
};

const watchPaths = [
  'docs/**/*',
  'packages/**/*',
  'plugins/**/*',
];

const ignorePaths = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
  '**/*.log',
  '**/.DS_Store',
  '**/build/**',
];

console.log('👀 Starting file watcher...');
console.log('📂 Watching paths:', watchPaths);
console.log('🚫 Ignoring paths:', ignorePaths);

const watcher = chokidar.watch(watchPaths, {
  ignored: ignorePaths,
  persistent: true,
  cwd: rootDir,
});

watcher.on('ready', () => {
  console.log('✨ File watcher ready');
  console.log('🔨 Running initial build...');
  runBuild();
});

watcher.on('change', (filePath) => {
  console.log(`📝 File changed: ${filePath}`);
  runBuild();
});

watcher.on('add', (filePath) => {
  console.log(`➕ File added: ${filePath}`);
  runBuild();
});

watcher.on('unlink', (filePath) => {
  console.log(`➖ File removed: ${filePath}`);
  runBuild();
});

watcher.on('error', (error) => {
  console.error('❌ Watcher error:', error);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Stopping file watcher...');
  if (buildProcess) {
    buildProcess.kill();
  }
  watcher.close().then(() => {
    console.log('👋 File watcher stopped');
    process.exit(0);
  });
});

console.log('Press Ctrl+C to stop');