import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { encodeChannelKey } from "../../../packages/core/dist/index.mjs";

const { values: options } = parseArgs({
  options: {
    framework: { type: "string" },
    platform: { type: "string" },
  },
});
const framework = options.framework;
const platform = options.platform;
if (
  !["react", "vue", "octane"].includes(framework ?? "") ||
  !["ios", "android"].includes(platform ?? "")
) {
  throw new Error(
    "Usage: node scripts/e2e-kysely-deploy.mjs --framework <react|vue|octane> --platform <ios|android>",
  );
}

const example = fileURLToPath(new URL("../", import.meta.url));
const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const origin = process.env.HOT_UPDATER_OTA_ORIGIN ?? "http://127.0.0.1:18791";
const token = (
  await fs.readFile(
    process.env.HOT_UPDATER_ADMIN_TOKEN_FILE ?? "/tmp/lynx-e2e-admin-token",
    "utf8",
  )
).trim();
const storageDir = process.env.HOT_UPDATER_STORAGE_DIR;
const signingKey = process.env.HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY;
if (!storageDir || !signingKey) {
  throw new Error(
    "HOT_UPDATER_STORAGE_DIR and HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY are required",
  );
}

const runtimeId =
  platform === "ios"
    ? "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v2"
    : "android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v2";
const channel = `ota-${framework}`;
const source = path.join(
  example,
  ".hot-updater/g1",
  framework,
  "B-sdk3-managed",
);
const project = path.join(
  example,
  ".hot-updater/e2e-kysely",
  `${framework}-${platform}-${crypto.randomUUID()}`,
);
await fs.mkdir(project, { recursive: true });
await fs.writeFile(
  path.join(project, "package.json"),
  JSON.stringify({ name: "lynx-e2e-kysely", private: true, type: "module" }),
);
for (const nativePlatform of ["ios", "android"]) {
  await fs.symlink(
    path.join(example, nativePlatform),
    path.join(project, nativePlatform),
  );
}

const moduleUrl = (relative) =>
  pathToFileURL(path.join(workspace, relative)).href;
const config = `import fs from "node:fs/promises";
import path from "node:path";
import { lynx } from ${JSON.stringify(moduleUrl("packages/lynx/dist/build.mjs"))};
import { standaloneRepository } from ${JSON.stringify(moduleUrl("plugins/standalone/dist/index.mjs"))};
import { localFsStorage } from ${JSON.stringify(moduleUrl("examples-server/hono-kysely-pglite/src/localFsStorage.mjs"))};
const token = ${JSON.stringify(token)};
export default {
  updateStrategy: "appVersion",
  compressStrategy: "zip",
  patch: { enabled: false },
  build: ({ cwd }) => {
    const plugin = lynx({
      build: async ({ outDir }) => {
        await fs.cp(${JSON.stringify(source)}, outDir, { recursive: true });
        return { entry: "main.lynx.bundle", runtimeId: ${JSON.stringify(runtimeId)} };
      },
    })({ cwd });
    return {
      ...plugin,
      build: async (args) => {
        const result = await plugin.build(args);
        await fs.writeFile(
          path.join(cwd, "build-result.json"),
          JSON.stringify(result, null, 2),
        );
        return result;
      },
    };
  },
  database: standaloneRepository({
    baseUrl: ${JSON.stringify(`${origin}/hot-updater/admin`)},
    commonHeaders: { authorization: "Bearer " + token },
  }),
  storage: localFsStorage({
    directory: ${JSON.stringify(storageDir)},
    signingKey: ${JSON.stringify(signingKey)},
  }),
};
`;
await fs.writeFile(path.join(project, "hot-updater.config.mjs"), config);

const cli = path.join(workspace, "packages/hot-updater/dist/index.mjs");
const logPath = path.join(project, "cli.log");
const log = await fs.open(logPath, "wx");
try {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        "deploy",
        "-p",
        platform,
        "-t",
        "1.0.x",
        "-c",
        channel,
        "-o",
        path.join(project, "output"),
        "-m",
        `Lynx agent-device E2E ${framework} ${platform}`,
      ],
      { cwd: project, stdio: ["ignore", log.fd, log.fd] },
    );
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`deploy failed (${code ?? signal}); ${logPath}`)),
    );
  });
} finally {
  await log.close();
}

const build = JSON.parse(
  await fs.readFile(path.join(project, "build-result.json"), "utf8"),
);
const catalogUrl = `${origin}/hot-updater/release-catalogs/app-version/${platform}/${encodeChannelKey(channel)}/1.0.0`;
const catalog = await (await fetch(catalogUrl)).json();
const release = catalog.releases.find((row) => row.bundleId === build.bundleId);
if (!release) {
  throw new Error(`Deployed bundle ${build.bundleId} missing from ${catalogUrl}`);
}
const receipt = {
  framework,
  platform,
  channel,
  runtimeId,
  bundleId: build.bundleId,
  releaseId: release.releaseId,
  catalogId: catalog.catalogId,
  catalogUrl,
};
await fs.writeFile(
  path.join(project, "receipt.json"),
  JSON.stringify(receipt, null, 2),
);
console.log(JSON.stringify(receipt));
