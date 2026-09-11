#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platformArg = process.argv.includes("--platform")
  ? process.argv[process.argv.indexOf("--platform") + 1]
  : "all";
const platforms =
  platformArg === "all"
    ? ["ios", "android"]
    : platformArg === "ios" || platformArg === "android"
      ? [platformArg]
      : null;
if (!platforms) {
  throw new Error("Usage: node scripts/build-e2e-native.mjs --platform <ios|android|all>");
}

function run(command, args, cwd) {
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
    run(
      "xcodebuild",
      [
        "-workspace",
        "SparklingGo.xcworkspace",
        "-scheme",
        "SparklingGo",
        "-configuration",
        "Release",
        "-sdk",
        "iphonesimulator",
        "-derivedDataPath",
        "build",
        "CODE_SIGNING_ALLOWED=NO",
        "build",
      ],
      path.join(exampleDir, "ios"),
    );
    continue;
  }
  run(
    "./gradlew",
    [":app:assembleRelease"],
    path.join(exampleDir, "android"),
  );
}
