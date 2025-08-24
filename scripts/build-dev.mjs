#!/usr/bin/env node
import { execa } from "execa";
import path from "path";
import { fileURLToPath } from "url";
import chokidar from "chokidar";
import picocolors from "picocolors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

let buildProcess = null;
let buildQueue = false;

const runBuild = async () => {
  if (buildProcess) {
    buildQueue = true;
    return;
  }

  console.log(picocolors.blue("🔨 Building..."));
  
  try {
    buildProcess = execa("pnpm", ["-w", "build"], {
      stdio: "inherit",
      cwd: rootDir,
      env: {
        ...process.env,
        NX_TUI: "false",
      },
    });

    await buildProcess;
    buildProcess = null;
    console.log(picocolors.green("✅ Build completed"));
    
    if (buildQueue) {
      buildQueue = false;
      setTimeout(runBuild, 100);
    }
  } catch (error) {
    buildProcess = null;
    console.log(picocolors.red(`❌ Build failed (${error.exitCode || 'unknown'})`));
    
    if (buildQueue) {
      buildQueue = false;
      setTimeout(runBuild, 100);
    }
  }
};

const watchPaths = ["docs/**/*", "packages/**/*", "plugins/**/*"];

const ignorePaths = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/*.log",
  "**/.DS_Store",
  "**/build/**",
];

console.log("👀 Watching for changes...");

const watcher = chokidar.watch(watchPaths, {
  ignored: ignorePaths,
  persistent: true,
  cwd: rootDir,
});

watcher.on("ready", () => {
  console.log("✨ Watcher ready - running initial build");
  runBuild();
});

watcher.on("change", (filePath) => {
  console.log(picocolors.yellow(`📝 ${filePath}`));
  runBuild();
});

watcher.on("add", (filePath) => {
  console.log(picocolors.green(`➕ ${filePath}`));
  runBuild();
});

watcher.on("unlink", (filePath) => {
  console.log(picocolors.red(`➖ ${filePath}`));
  runBuild();
});

watcher.on("error", (error) => {
  console.error("❌ Watcher error:", error);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Stopping file watcher...");
  if (buildProcess) {
    buildProcess.kill();
  }
  watcher.close().then(() => {
    console.log("👋 File watcher stopped");
    process.exit(0);
  });
});

console.log("Press Ctrl+C to stop");
