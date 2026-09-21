import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const LYNX_E2E_BUILTIN_BUNDLE_ID =
  "00000000-0000-7000-8000-000000000000";

export const LYNX_E2E_SDK3_FILES = [
  "assets/OFL.txt",
  "assets/bootstrap.js",
  "assets/probe.png",
  "assets/probe.ttf",
  "detail.lynx.bundle",
  "dynamic/component.lynx.bundle",
  "main.lynx.bundle",
] as const;

export const LYNX_E2E_PAGE_ENTRIES = [
  "detail.lynx.bundle",
  "main.lynx.bundle",
] as const;

export const LYNX_E2E_PAGE_ESSENTIAL_RESOURCES = [
  {
    entry: "detail.lynx.bundle",
    resources: ["detail.lynx.bundle"],
  },
  {
    entry: "main.lynx.bundle",
    resources: [
      "assets/bootstrap.js",
      "assets/probe.png",
      "assets/probe.ttf",
      "dynamic/component.lynx.bundle",
      "main.lynx.bundle",
    ],
  },
] as const;

export function lynxE2eRuntimeId(platform: "ios" | "android"): string {
  return platform === "ios"
    ? "sparkling-c4ce8d2-navigation-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-managed-pages-v1"
    : "android-sparkling-2.1.0-rc.12-navsrc-937f70d7c3012a5a-lynx-3.9.0-primjs-3.8.0-alpha.6-managed-pages-v1";
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
  const pageEntries = LYNX_E2E_PAGE_ENTRIES;
  const pageEssentialResources = LYNX_E2E_PAGE_ESSENTIAL_RESOURCES;
  if (!pageEntries.includes(entry)) {
    throw new Error(`Lynx embedded main entry is not a page: ${entry}`);
  }
  for (const pageEntry of pageEntries) {
    const pageStat = await fs.stat(path.join(options.root, pageEntry));
    if (!pageStat.isFile() || pageStat.size === 0) {
      throw new Error(`Lynx embedded page entry missing: ${pageEntry}`);
    }
  }

  await fs.writeFile(
    path.join(options.root, "hot-updater-lynx.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        bundleId: options.bundleId,
        platform: options.platform,
        entry,
        pageEntries,
        pageEssentialResources,
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

type NativeEmbeddedPlatform = "ios" | "android";

export async function validateLynxEmbeddedDirectory(options: {
  readonly root: string;
  readonly platform: NativeEmbeddedPlatform;
  readonly expectedBundleId?: string;
  readonly expectedRuntimeId?: string;
  readonly expectedFiles?: readonly string[];
}): Promise<{
  readonly bundleId: string;
  readonly entry: string;
  readonly pageEntries: readonly string[];
  readonly pageEssentialResources: readonly {
    readonly entry: string;
    readonly resources: readonly string[];
  }[];
  readonly runtimeId: string;
  readonly manifestDigest: string;
}> {
  const metadataPath = path.join(options.root, "hot-updater-lynx.json");
  const manifestPath = path.join(options.root, "manifest.json");
  const [metadataBytes, manifestBytes] = await Promise.all([
    fs.readFile(metadataPath),
    fs.readFile(manifestPath),
  ]);
  const metadata = JSON.parse(metadataBytes.toString("utf8")) as {
    bundleId?: string;
    entry?: string;
    pageEntries?: string[];
    pageEssentialResources?: { entry: string; resources: string[] }[];
    platform?: string;
    runtimeId?: string;
  };
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    bundleId?: string;
    assets?: Record<string, { fileHash?: string }>;
  };
  if (
    !metadata.bundleId ||
    manifest.bundleId !== metadata.bundleId ||
    metadata.platform !== options.platform ||
    !metadata.runtimeId ||
    !metadata.entry ||
    JSON.stringify(metadata.pageEntries) !==
      JSON.stringify(LYNX_E2E_PAGE_ENTRIES) ||
    JSON.stringify(metadata.pageEssentialResources) !==
      JSON.stringify(LYNX_E2E_PAGE_ESSENTIAL_RESOURCES) ||
    (options.expectedBundleId &&
      metadata.bundleId !== options.expectedBundleId) ||
    (options.expectedRuntimeId &&
      metadata.runtimeId !== options.expectedRuntimeId)
  ) {
    throw new Error("Generated Lynx embedded identity is invalid.");
  }
  const files = await listRelativeFiles(options.root);
  const payloadFiles = files.filter((name) => name !== "manifest.json");
  if (
    !payloadFiles.includes(metadata.entry) ||
    !payloadFiles.includes("hot-updater-lynx.json") ||
    Object.keys(manifest.assets ?? {})
      .sort()
      .join("\0") !== payloadFiles.sort().join("\0")
  ) {
    throw new Error("Generated Lynx embedded manifest coverage is invalid.");
  }
  for (const name of options.expectedFiles ?? []) {
    if (!payloadFiles.includes(name)) {
      throw new Error(`Generated Lynx embedded resource is missing: ${name}`);
    }
  }
  for (const descriptor of metadata.pageEssentialResources ?? []) {
    for (const name of descriptor.resources) {
      if (!payloadFiles.includes(name)) {
        throw new Error(
          `Generated Lynx embedded essential resource is missing: ${name}`,
        );
      }
    }
  }
  for (const name of payloadFiles) {
    const expected = manifest.assets?.[name]?.fileHash;
    const actual = sha256File(await fs.readFile(path.join(options.root, name)));
    if (!expected || expected !== actual) {
      throw new Error(`Generated Lynx embedded hash mismatch: ${name}`);
    }
  }
  return {
    bundleId: metadata.bundleId,
    entry: metadata.entry,
    pageEntries: metadata.pageEntries,
    pageEssentialResources: metadata.pageEssentialResources,
    runtimeId: metadata.runtimeId,
    manifestDigest: sha256File(manifestBytes),
  };
}

export async function materializeLynxNativeEmbedded(options: {
  readonly exampleDir: string;
  readonly platform: NativeEmbeddedPlatform;
  readonly source: string;
  readonly framework?: "react" | "vue" | "octane";
  readonly variant?: "sdk1" | "sdk2" | "sdk3";
  readonly resetPlatformRoot?: boolean;
}): Promise<readonly string[]> {
  const framework = options.framework ?? "react";
  const variant = options.variant ?? "sdk3";
  const embedded = await validateLynxEmbeddedDirectory({
    root: options.source,
    platform: options.platform,
    expectedBundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
    expectedRuntimeId: lynxE2eRuntimeId(options.platform),
    expectedFiles:
      variant === "sdk1"
        ? ["assets/probe.png", "main.lynx.bundle"]
        : LYNX_E2E_SDK3_FILES,
  });
  if (embedded.entry !== "main.lynx.bundle") {
    throw new Error("Generated Lynx embedded entry is invalid.");
  }
  if (options.platform === "ios") {
    const publicRoot = path.join(options.exampleDir, "ios/Embedded/Public");
    const destination = path.join(publicRoot, framework);
    if (options.resetPlatformRoot !== false) {
      await fs.rm(path.join(options.exampleDir, "ios/Embedded"), {
        recursive: true,
        force: true,
      });
    } else {
      await fs.rm(destination, { recursive: true, force: true });
      await fs.rm(path.join(publicRoot, `${framework}-native.json`), {
        force: true,
      });
    }
    await fs.mkdir(publicRoot, { recursive: true });
    await fs.cp(options.source, destination, { recursive: true });
    const descriptorPath = path.join(publicRoot, `${framework}-native.json`);
    await fs.writeFile(
      descriptorPath,
      `${JSON.stringify({
        framework,
        variant,
        runtimeId: embedded.runtimeId,
        bundleId: embedded.bundleId,
        minimumBundleId: embedded.bundleId,
        manifestDigest: embedded.manifestDigest,
        entry: embedded.entry,
        pageEntries: embedded.pageEntries,
        pageEssentialResources: embedded.pageEssentialResources,
      })}\n`,
    );
    return [
      path.join(destination, "detail.lynx.bundle"),
      path.join(destination, "main.lynx.bundle"),
      path.join(destination, "manifest.json"),
      descriptorPath,
    ];
  }

  const embeddedRoot = path.join(
    options.exampleDir,
    "android/.hot-updater/embedded",
  );
  const destination = path.join(embeddedRoot, "ota", framework, "A");
  if (options.resetPlatformRoot !== false) {
    await fs.rm(embeddedRoot, { recursive: true, force: true });
  } else {
    await fs.rm(destination, { recursive: true, force: true });
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(options.source, destination, { recursive: true });
  return [
    path.join(destination, "detail.lynx.bundle"),
    path.join(destination, "main.lynx.bundle"),
    path.join(destination, "manifest.json"),
  ];
}

export async function compileLynxE2eEmbedded(options: {
  readonly exampleDir: string;
  readonly platform: "ios" | "android";
  readonly env: NodeJS.ProcessEnv;
  readonly outDir?: string;
}): Promise<string> {
  const outDir =
    options.outDir ?? lynxE2eEmbeddedDir(options.exampleDir, options.platform);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const compileEnv: NodeJS.ProcessEnv = {
    ...options.env,
    HOT_UPDATER_BUILD_DIR: outDir,
    HOT_UPDATER_E2E_OVERLAY_MARKER: "targeted-qa-detox",
  };
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
      env: compileEnv,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `rspeedy e2e embed failed: ${result.stderr || result.stdout || result.status}`,
    );
  }
  const { finishLynxE2eBundle } =
    await import("../../examples/lynx/scripts/e2e-assets.mjs");
  await finishLynxE2eBundle(outDir);
  await packageLynxEmbeddedDirectory({
    root: outDir,
    platform: options.platform,
    bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
    runtimeId: lynxE2eRuntimeId(options.platform),
  });
  const bundle = await fs.readFile(path.join(outDir, "main.lynx.bundle"));
  const detailBundle = await fs.readFile(
    path.join(outDir, "detail.lynx.bundle"),
  );
  const bundleTexts = [bundle, detailBundle].map((bytes) =>
    bytes.toString("utf8"),
  );
  if (bundleTexts.some((text) => !text.includes("targeted-qa-detox"))) {
    throw new Error(
      "A Lynx page bundle is missing scenario marker targeted-qa-detox",
    );
  }
  if (bundleTexts.some((text) => text.includes("E2E_SAFE_BUNDLE_IDS"))) {
    throw new Error("Lynx overlay bundle contains the E2E crash guard");
  }
  return outDir;
}
