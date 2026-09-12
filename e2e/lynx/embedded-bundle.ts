import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const LYNX_E2E_BUILTIN_BUNDLE_ID =
  "00000000-0000-7000-8000-000000000000";

export function lynxE2eRuntimeId(platform: "ios" | "android"): string {
  return platform === "ios"
    ? "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v2"
    : "android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v2";
}

export function lynxE2eEmbeddedDir(
  exampleDir: string,
  platform: "ios" | "android",
): string {
  return path.join(exampleDir, ".hot-updater", "e2e-embedded", platform);
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const names: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Lynx embedded tree cannot contain symlink: ${full}`);
      }
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Lynx embedded tree has a non-file: ${full}`);
      }
      names.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  await walk(root);
  return names.sort();
}

function sha256File(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function packageLynxEmbeddedDirectory(options: {
  readonly root: string;
  readonly platform: "ios" | "android";
  readonly bundleId: string;
  readonly runtimeId: string;
  readonly entry?: string;
}): Promise<{ readonly manifestDigest: string }> {
  const entry = options.entry ?? "main.lynx.bundle";
  const entryPath = path.join(options.root, entry);
  const entryStat = await fs.stat(entryPath);
  if (!entryStat.isFile() || entryStat.size === 0) {
    throw new Error(`Lynx embedded entry missing: ${entry}`);
  }

  await fs.writeFile(
    path.join(options.root, "hot-updater-lynx.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        bundleId: options.bundleId,
        platform: options.platform,
        entry,
        runtimeId: options.runtimeId,
      },
      null,
      2,
    )}\n`,
  );

  const assets: Record<string, { fileHash: string }> = {};
  for (const relative of await listRelativeFiles(options.root)) {
    if (relative === "manifest.json") continue;
    const bytes = await fs.readFile(path.join(options.root, relative));
    assets[relative] = { fileHash: sha256File(bytes) };
  }
  if (!assets[entry] || !assets["hot-updater-lynx.json"]) {
    throw new Error("Lynx embedded metadata or entry was not hashed.");
  }

  const manifest = `${JSON.stringify(
    { bundleId: options.bundleId, assets },
    null,
    2,
  )}\n`;
  const manifestBytes = Buffer.from(manifest, "utf8");
  await fs.writeFile(path.join(options.root, "manifest.json"), manifestBytes);
  return { manifestDigest: sha256File(manifestBytes) };
}

export async function compileLynxE2eEmbedded(options: {
  readonly exampleDir: string;
  readonly platform: "ios" | "android";
  readonly env: NodeJS.ProcessEnv;
}): Promise<string> {
  const outDir = lynxE2eEmbeddedDir(options.exampleDir, options.platform);
  await fs.rm(outDir, { recursive: true, force: true });
  for (const cacheDir of [
    ".rspeedy",
    "node_modules/.cache",
    "node_modules/.rspack",
  ]) {
    await fs.rm(path.join(options.exampleDir, cacheDir), {
      recursive: true,
      force: true,
    });
  }
  await fs.mkdir(outDir, { recursive: true });
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "rspeedy",
      "build",
      "--config",
      "e2e.lynx.config.ts",
      "--environment",
      "lynx",
    ],
    {
      cwd: options.exampleDir,
      encoding: "utf8",
      env: {
        ...options.env,
        HOT_UPDATER_BUILD_DIR: outDir,
        HOT_UPDATER_E2E_OVERLAY_MARKER: "targeted-qa-detox",
      },
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `rspeedy e2e embed failed: ${result.stderr || result.stdout || result.status}`,
    );
  }
  await packageLynxEmbeddedDirectory({
    root: outDir,
    platform: options.platform,
    bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
    runtimeId: lynxE2eRuntimeId(options.platform),
  });
  const bundle = await fs.readFile(path.join(outDir, "main.lynx.bundle"));
  if (!bundle.toString("utf8").includes("targeted-qa-detox")) {
    throw new Error(
      "Lynx overlay bundle is missing scenario marker targeted-qa-detox",
    );
  }
  return outDir;
}
