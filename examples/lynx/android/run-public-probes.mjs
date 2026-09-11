// Public SDK3 catalog/controller path. No G1 placement or native selection injection.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const serial = process.argv[2] ?? "emulator-5558";
const android = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(android, "../../..");
const app = "com.hotupdater.lynxexample";
const embedded = "00000000-0000-0000-0000-000000000000";
const exec = (cmd, args) =>
  execFileSync(cmd, args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 12 * 1024 * 1024,
  });
const adb = (args) => exec("adb", ["-s", serial, ...args]);
const output = path.join(android, ".probe-results", `${Date.now()}-public-sdk3`);
await fs.mkdir(output, {recursive: true});

const nativeLogs = () => adb(["logcat", "-d", "-s", "HotUpdaterLynx:I"]);
const resourceLines = (bundleId) => [
  `resource release=${bundleId} url=hot-updater:///main.lynx.bundle`,
  `resource release=${bundleId} url=hot-updater:///assets/probe.png`,
  `resource release=${bundleId} url=hot-updater:///assets/bootstrap.js`,
  `resource release=${bundleId} url=hot-updater:///dynamic/component.lynx.bundle`,
  `font-loaded release=${bundleId}`,
];
async function waitLog(pattern, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = nativeLogs();
    if (text.includes(pattern)) return text;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Error(`Missing log ${pattern}\n${nativeLogs().slice(-5000)}`);
}
async function waitResources(bundleId, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = nativeLogs();
    if (resourceLines(bundleId).every((line) => text.includes(line))) return text;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Error(
    `Missing managed resources for ${bundleId}\n${nativeLogs().slice(-8000)}`,
  );
}
const screenshot = (name) =>
  fs.writeFile(
    path.join(output, name),
    execFileSync("adb", ["-s", serial, "exec-out", "screencap", "-p"]),
  );

const size = adb(["shell", "wm", "size"]).match(/(\d+)x(\d+)/);
assert(size);
const width = Number(size[1]);
const height = Number(size[2]);
const tap = (ratio) =>
  adb([
    "shell",
    "input",
    "tap",
    String(Math.floor(width / 2)),
    String(Math.floor(height * ratio)),
  ]);

const launch = async (framework) => {
  adb(["shell", "am", "force-stop", app]);
  adb(["logcat", "-c"]);
  adb([
    "shell",
    "am",
    "start",
    "-n",
    `${app}/.OtaActivity`,
    "--es",
    "framework",
    framework,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  // 16 KB compatibility dialog covers the Lynx actions after pm clear.
  adb(["shell", "input", "tap", "1027", "2535"]);
  await new Promise((resolve) => setTimeout(resolve, 400));
};

const apk = path.join(android, "app/build/outputs/apk/release/app-release.apk");
const binaryHash = createHash("sha256")
  .update(await fs.readFile(apk))
  .digest("hex");
const results = [];
for (const framework of ["react", "vue", "octane"]) {
  adb(["shell", "pm", "clear", app]);
  await launch(framework);
  await waitResources(embedded);
  let text = await waitLog(`confirmed bundle=${embedded}`);
  await fs.writeFile(path.join(output, `${framework}-A.logcat.txt`), text);
  await screenshot(`${framework}-A.png`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  tap(0.47);
  text = await waitLog("verified-preparation");
  assert.match(text, /prepare-selection bundle=/);
  await new Promise((resolve) => setTimeout(resolve, 500));
  tap(0.56);
  text = await waitLog("selection-staged");
  const staged = text.match(/selection-staged bundle=([0-9a-f-]+) release=([0-9a-f-]+)/);
  assert(staged);
  await launch(framework);
  text = await waitResources(staged[1]);
  assert.match(text, new RegExp(`attempt-before-evaluation bundle=${staged[1]}`));
  await fs.writeFile(path.join(output, `${framework}-B.logcat.txt`), text);
  await screenshot(`${framework}-B.png`);
  await launch(framework);
  text = await waitResources(staged[1]);
  assert.match(text, new RegExp(`attempt-before-evaluation bundle=${staged[1]}`));
  await fs.writeFile(
    path.join(output, `${framework}-B-retain.logcat.txt`),
    text,
  );
  results.push({
    framework,
    bundleId: staged[1],
    releaseId: staged[2],
    retained: true,
  });
  console.log(
    framework,
    "public check/prepare → install → restart B passed",
    staged[2],
  );
}
await fs.writeFile(
  path.join(output, "summary.json"),
  JSON.stringify({binaryHash, serial, results}, null, 2),
);
console.log(JSON.stringify({output, binaryHash, passed: results.length}));
