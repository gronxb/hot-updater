#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";
import * as p from "@clack/prompts";
import chokidar from "chokidar";
import { execa } from "execa";
import picocolors from "picocolors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

let buildProcess = null;
let debounceTimeout = null;
const DEBOUNCE_DELAY = 300; // 300ms delay

const runBuild = async () => {
  // Cancel existing build if running
  if (buildProcess) {
    buildProcess.kill();
    p.log.info("Build cancelled - new build starting");
  }

  p.log.info(picocolors.cyan("🔨 Building packages..."));

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
    p.log.success("✅ Build completed successfully");
  } catch (error) {
    buildProcess = null;
  }
};

const debouncedRunBuild = (filePath) => {
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

p.intro("🚀 Hot Updater Build Watcher");

p.log.info(`👀 Watching: ${watchPaths.join(", ")}`);
p.log.info("🚫 Ignoring: dist, node_modules, .git, logs, fingerprint.json");

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
  p.log.success("✨ File watcher ready");
  runBuild();
});

watcher.on("change", (filePath) => {
  p.log.info(picocolors.blueBright(`📝 Changed: ${filePath}`));
  debouncedRunBuild(filePath);
});

watcher.on("add", (filePath) => {
  p.log.info(picocolors.greenBright(`➕ Added: ${filePath}`));
  debouncedRunBuild(filePath);
});

watcher.on("unlink", (filePath) => {
  p.log.info(picocolors.red(`➖ Removed: ${filePath}`));
  debouncedRunBuild(filePath);
});

watcher.on("error", (error) => {
  p.log.error(`Watcher error: ${error.message}`);
});

process.on("SIGINT", () => {
  p.log.warn("\n🛑 Stopping file watcher...");
  if (buildProcess) {
    buildProcess.kill();
  }
  if (debounceTimeout) {
    clearTimeout(debounceTimeout);
  }
  watcher.close().then(() => {
    p.outro("👋 File watcher stopped");
    process.exit(0);
  });
});

p.note("Press Ctrl+C to stop", "Instructions");
