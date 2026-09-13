#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const exampleDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliArgs = process.argv.slice(2).filter((argument) => argument !== "--");
const { values } = parseArgs({
  args: cliArgs,
  options: {
    platform: { type: "string", default: "all" },
    target: { type: "string", default: "matrix" },
    "dry-run": { type: "boolean" },
  },
  strict: true,
});
const platforms =
  values.platform === "all"
    ? ["ios", "android"]
    : values.platform === "ios" || values.platform === "android"
      ? [values.platform]
      : null;
if (!platforms || !["matrix", "scaffold"].includes(values.target)) {
  throw new Error(
    "Usage: node scripts/build-e2e-native.mjs --platform <ios|android|all> --target <matrix|scaffold> [--dry-run]",
  );
}

const target = values.target;
const definitions = {
  matrix: {
    appId: "com.hotupdater.lynxmatrix",
    iosScheme: "SparklingMatrixHarness",
    androidModule: "matrix-app",
    receipt: "matrix-native-artifacts.json",
  },
  scaffold: {
    appId: "com.hotupdater.lynxexample",
    iosScheme: "SparklingGo",
    androidModule: "app",
    receipt: "scaffold-native-artifacts.json",
  },
};
const definition = definitions[target];
const artifacts = {};

function run(command, args, cwd) {
  if (values["dry-run"]) return;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  }
}

for (const platform of platforms) {
  if (platform === "ios") {
    const iosDir = path.join(exampleDir, "ios");
    const derivedDataPath = path.join("build", target);
    const artifactPath = path.join(
      iosDir,
      derivedDataPath,
      "Build/Products/Release-iphonesimulator",
      `${definition.iosScheme}.app`,
    );
    run("sh", ["bootstrap.sh"], iosDir);
    run(
      "xcodebuild",
      [
        "-workspace",
        "SparklingGo.xcworkspace",
        "-scheme",
        definition.iosScheme,
        "-configuration",
        "Release",
        "-sdk",
        "iphonesimulator",
        "-derivedDataPath",
        derivedDataPath,
        "CODE_SIGNING_ALLOWED=NO",
        "build",
      ],
      iosDir,
    );
    artifacts.ios = {
      path: artifactPath,
      scheme: definition.iosScheme,
    };
    continue;
  }
  const androidDir = path.join(exampleDir, "android");
  const task = `:${definition.androidModule}:assembleRelease`;
  const artifactPath = path.join(
    androidDir,
    definition.androidModule,
    "build/outputs/apk/release",
    `${definition.androidModule}-release.apk`,
  );
  run("./gradlew", [task, "-PlynxE2eDebuggable=true"], androidDir);
  artifacts.android = { path: artifactPath, task };
}

const receipt = {
  schemaVersion: "lynx-native-artifacts-v1",
  target,
  appId: definition.appId,
  artifacts,
};

if (!values["dry-run"]) {
  for (const [platform, artifact] of Object.entries(artifacts)) {
    if (!fs.existsSync(artifact.path)) {
      throw new Error(`Missing ${platform} build artifact: ${artifact.path}`);
    }
  }
  const receiptPath = path.join(
    exampleDir,
    ".hot-updater/public-matrix",
    definition.receipt,
  );
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  receipt.receiptPath = receiptPath;
}

console.log(`LYNX_NATIVE_ARTIFACTS=${JSON.stringify(receipt)}`);
