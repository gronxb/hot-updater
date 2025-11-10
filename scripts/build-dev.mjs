#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";
import chokidar from "chokidar";
import { execa } from "execa";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

let buildProcess = null;
let debounceTimeout = null;
const DEBOUNCE_DELAY = 1000; // 1s delay

const runBuild = async () => {
  // Cancel existing build if running
  if (buildProcess) {
    buildProcess.kill();
    console.log("Build cancelled - new build starting");
  }

  console.log("Building packages...");

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
    console.log("Build completed successfully");
  } catch (error) {
    buildProcess = null;
  }
};

const debouncedRunBuild = () => {
  // Clear existing timeout
  if (debounceTimeout) {
    clearTimeout(debounceTimeout);
  }

  // Set new timeout
  debounceTimeout = setTimeout(() => {
    runBuild();
    debounceTimeout = null;
  }, DEBOUNCE_DELAY);
};

const watchPaths = ["docs", "packages", "plugins"];

console.log("Hot Updater Build Watcher");

console.log(`Watching: ${watchPaths.join(", ")}`);
console.log("Ignoring: dist, node_modules, .git, logs, fingerprint.json");

const watcher = chokidar.watch(watchPaths, {
  ignoreInitial: true,
  ignored: (filePath, stats) => {
    if (!stats) return false;

    // Ignore directories we don't want to watch
    if (filePath.includes("node_modules")) return true;
    if (filePath.includes("/dist/")) return true;
    if (filePath.includes("/lib/")) return true;
    if (filePath.includes("/.git/")) return true;
    if (filePath.includes("/build/")) return true;

    // Only watch specific file extensions
    if (stats.isFile()) {
      const allowedExtensions = [".js", ".ts", ".tsx", ".json"];
      const hasAllowedExtension = allowedExtensions.some((ext) =>
        filePath.endsWith(ext),
      );
      if (!hasAllowedExtension) return true;

      // Ignore specific files even with allowed extensions
      if (filePath.endsWith(".js.map")) return true;
      if (filePath.endsWith("fingerprint.json")) return true;
    }

    return false;
  },
  persistent: true,
  cwd: rootDir,
});

watcher.on("ready", () => {
  console.log("File watcher ready");
  runBuild();
});

watcher.on("change", (filePath) => {
  console.log(`Changed: ${filePath}`);
  debouncedRunBuild();
});

watcher.on("add", (filePath) => {
  console.log(`Added: ${filePath}`);
  debouncedRunBuild();
});

watcher.on("unlink", (filePath) => {
  console.log(`Removed: ${filePath}`);
  debouncedRunBuild();
});

watcher.on("error", (error) => {
  console.error(`Watcher error: ${error.message}`);
});

process.on("SIGINT", () => {
  console.warn("\nStopping file watcher...");
  if (buildProcess) {
    buildProcess.kill();
  }
  if (debounceTimeout) {
    clearTimeout(debounceTimeout);
  }
  watcher.close().then(() => {
    console.log("File watcher stopped");
    process.exit(0);
  });
});

console.log("Press Ctrl+C to stop");
