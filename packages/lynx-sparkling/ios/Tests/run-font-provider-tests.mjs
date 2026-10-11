// Usage: node run-font-provider-tests.mjs <Lynx source directory>
// Tests the production wrapper against unchanged Foundation-only Lynx classes.
// This does not build the engine or verify its font cache/rendering behavior.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const lynx = process.argv[2];
if (!lynx) {
  throw new Error("Pass the installed Lynx source directory.");
}
const tests = path.dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), "lynx-font-provider-"));
const source = path.join(lynx, "platform/darwin/common/lynx");
const upstream = path.join(root, "Sources/Lynx");
const include = path.join(upstream, "include");

try {
  mkdirSync(path.join(include, "Lynx"), { recursive: true });
  for (const [directory, name] of [
    ["resource", "LynxResourceRequest"],
    ["resource", "LynxResourceResponse"],
    ["service", "LynxServiceResourceRequestParameters"],
  ]) {
    cpSync(
      path.join(source, directory, `${name}.m`),
      path.join(upstream, `${name}.m`),
    );
    cpSync(
      path.join(source, "public", directory, `${name}.h`),
      path.join(include, "Lynx", `${name}.h`),
    );
  }
  cpSync(
    path.join(source, "public/resource/LynxResourceProvider.h"),
    path.join(include, "Lynx/LynxResourceProvider.h"),
  );
  writeFileSync(
    path.join(include, "module.modulemap"),
    'module Lynx { header "Lynx/LynxResourceProvider.h" export * }\n',
  );
  const wrapper = "ManagedFontResourceProvider.swift";
  const target = "HotUpdaterLynxSparkling";
  mkdirSync(path.join(root, "Sources", target), { recursive: true });
  cpSync(
    path.join(tests, "../Sources", target, wrapper),
    path.join(root, "Sources", target, wrapper),
  );
  cpSync(
    path.join(tests, `${target}Tests`),
    path.join(root, "Tests", `${target}Tests`),
    { recursive: true },
  );
  const artifact = path.resolve(tests, "../../../lynx/ios");
  writeFileSync(
    path.join(root, "Package.swift"),
    `// swift-tools-version: 5.10
import PackageDescription
let package = Package(
    name: "FontProviderTests",
    platforms: [.macOS(.v12)],
    dependencies: [.package(name: "Artifact", path: ${JSON.stringify(artifact)})],
    targets: [
        .target(name: "Lynx", cSettings: [.unsafeFlags(["-fobjc-arc"])]),
        .target(name: "${target}", dependencies: ["Lynx", .product(name: "HotUpdaterLynxArtifact", package: "Artifact")]),
        .testTarget(name: "${target}Tests", dependencies: ["${target}", "Lynx"]),
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
