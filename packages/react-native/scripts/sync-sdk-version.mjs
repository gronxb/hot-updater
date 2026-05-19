import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { transformSync } from "oxc-transform";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = join(packageRoot, "package.json");
const sdkVersionPath = join(packageRoot, "src", "sdkVersion.ts");
const backupPath = join(
  packageRoot,
  "node_modules",
  ".cache",
  "hot-updater-sdk-version.json",
);

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"));
const version = packageJson.version;

if (typeof version !== "string" || version.length === 0) {
  throw new Error("@hot-updater/react-native package.json is missing version");
}

const source = [
  "export const HOT_UPDATER_SDK_VERSION = HotUpdater.SDK_VERSION;",
  "",
].join("\n");

const code =
  transformSync(sdkVersionPath, source, {
    define: {
      "HotUpdater.SDK_VERSION": JSON.stringify(version),
    },
  })?.code ?? source;

const nextContents = code.endsWith("\n") ? code : `${code}\n`;

async function syncSdkVersion() {
  const currentContents = await readFile(sdkVersionPath, "utf-8").catch(
    () => "",
  );
  const existingBackup = await readFile(backupPath, "utf-8").catch(() => null);

  if (existingBackup !== null) {
    throw new Error(
      `SDK version backup already exists at ${backupPath}. Run sync:sdk-version restore before syncing again.`,
    );
  }

  await mkdir(dirname(backupPath), { recursive: true });
  await writeFile(
    backupPath,
    JSON.stringify({ contents: currentContents }, null, 2),
  );

  if (currentContents !== nextContents) {
    await writeFile(sdkVersionPath, nextContents);
  }
}

async function restoreSdkVersion() {
  const backup = await readFile(backupPath, "utf-8").catch(() => null);

  if (backup === null) {
    return;
  }

  const parsed = JSON.parse(backup);
  await writeFile(sdkVersionPath, parsed.contents);
  await rm(backupPath, { force: true });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      shell: process.platform === "win32",
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `${command} exited with signal ${signal}`
            : `${command} exited with code ${code}`,
        ),
      );
    });
  });
}

const [command = "once", separator, ...args] = process.argv.slice(2);

if (command === "sync") {
  await syncSdkVersion();
} else if (command === "restore") {
  await restoreSdkVersion();
} else if (command === "once") {
  await syncSdkVersion();
  await restoreSdkVersion();
} else if (command === "run") {
  if (separator !== "--" || args.length === 0) {
    throw new Error("Usage: sync-sdk-version.mjs run -- <command> [...args]");
  }

  await syncSdkVersion();
  try {
    await runCommand(args[0], args.slice(1));
  } finally {
    await restoreSdkVersion();
  }
} else {
  throw new Error(`Unknown sync-sdk-version command: ${command}`);
}
