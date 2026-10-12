// Exercises the production admission gate with the real public artifact controller.
// UIKit scene notifications and Lynx engine execution require device acceptance.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tests = path.dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), "lynx-scene-admission-"));
const target = "HotUpdaterLynxSparklingCore";
const testTarget = "HotUpdaterLynxSparklingSceneTests";
try {
  mkdirSync(path.join(root, "Sources", target), { recursive: true });
  cpSync(
    path.join(tests, "../Sources", target, "SparklingForegroundAdmission.swift"),
    path.join(root, "Sources", target, "SparklingForegroundAdmission.swift"),
  );
  cpSync(path.join(tests, testTarget), path.join(root, "Tests", testTarget), {
    recursive: true,
  });
  const artifact = path.resolve(tests, "../../../lynx/ios");
  writeFileSync(
    path.join(root, "Package.swift"),
    `// swift-tools-version: 5.10
import PackageDescription
let package = Package(
    name: "SceneAdmissionTests",
    platforms: [.macOS(.v12)],
    dependencies: [.package(name: "Artifact", path: ${JSON.stringify(artifact)})],
    targets: [
        .target(name: "${target}"),
        .testTarget(name: "${testTarget}", dependencies: ["${target}", .product(name: "HotUpdaterLynxArtifact", package: "Artifact")]),
    ]
)
`,
  );
  const result = spawnSync("swift", ["test", "--package-path", root], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
