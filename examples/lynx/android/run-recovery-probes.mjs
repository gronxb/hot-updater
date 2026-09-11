// Public-host and same-binary recovery on the Release APK. No G1 placement.
import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
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
const output = path.join(android, ".probe-results", `${Date.now()}-recovery`);
await fs.mkdir(output, {recursive: true});
const nativeLogs = () => adb(["logcat", "-d", "-s", "HotUpdaterLynx:I", "HotUpdaterLynxG2:I"]);
async function waitLog(pattern, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = nativeLogs();
    if (text.includes(pattern)) return text;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error(`Missing log ${pattern}\n${nativeLogs().slice(-6000)}`);
}
const size = adb(["shell", "wm", "size"]).match(/(\d+)x(\d+)/);
const width = Number(size[1]);
const height = Number(size[2]);
const tap = (ratio) =>
  adb(["shell", "input", "tap", String(Math.floor(width / 2)), String(Math.floor(height * ratio))]);
const dismiss = () => adb(["shell", "input", "tap", "1027", "2535"]);
const launchOta = async (framework, extra = []) => {
  adb(["shell", "am", "force-stop", app]);
  adb(["logcat", "-c"]);
  adb(["shell", "am", "start", "-n", `${app}/.OtaActivity`, "--es", "framework", framework, ...extra]);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  dismiss();
};

const results = [];

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
  "react",
  "--ez",
  "secondary",
  "true",
]);
const secondary = await waitLog("host-rejected-before-evaluation");
assert.match(secondary, /Secondary context must wait for primary selection/);
await fs.writeFile(path.join(output, "secondary-before-primary.logcat.txt"), secondary);
results.push({case: "secondary-before-primary", passed: true});
console.log("secondary-before-primary passed");

adb(["shell", "am", "force-stop", app]);
await new Promise((resolve) => setTimeout(resolve, 500));
adb(["uninstall", app]);
adb(["install", path.join(android, "app/build/outputs/apk/release/app-release.apk")]);
adb(["reverse", "tcp:18791", "tcp:18791"]);
await new Promise((resolve) => setTimeout(resolve, 1000));
await launchOta("react");
await waitLog(`confirmed bundle=${embedded}`);
await new Promise((resolve) => setTimeout(resolve, 800));
tap(0.47);
await waitLog("verified-preparation");
await new Promise((resolve) => setTimeout(resolve, 500));
tap(0.56);
const stagedLog = await waitLog("selection-staged");
const staged = stagedLog.match(/selection-staged bundle=([0-9a-f-]+) release=([0-9a-f-]+)/);
assert(staged);
let unconfirmed = false;
for (let attempt = 0; attempt < 8 && !unconfirmed; attempt++) {
  await launchOta("react");
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const text = nativeLogs();
    if (text.includes(`attempt-before-evaluation bundle=${staged[1]}`) &&
      !text.includes(`confirmed bundle=${staged[1]}`)) {
      adb(["shell", "am", "force-stop", app]);
      unconfirmed = true;
      await fs.writeFile(path.join(output, "unconfirmed-kill.logcat.txt"), text);
      break;
    }
    if (text.includes(`confirmed bundle=${staged[1]}`)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
assert(unconfirmed, "Could not kill B before confirmation");
await launchOta("react");
const recovered = await waitLog(`confirmed bundle=${embedded}`);
assert.match(recovered, new RegExp(`attempt-before-evaluation bundle=${embedded}`));
assert.doesNotMatch(recovered, new RegExp(`attempt-before-evaluation bundle=${staged[1]}`));
await fs.writeFile(path.join(output, "unconfirmed-recovered-A.logcat.txt"), recovered);
results.push({
  case: "unconfirmed-B-recovers-to-embedded",
  passed: true,
  excludedRelease: staged[2],
});
console.log("unconfirmed-B-recovers-to-embedded passed", staged[2]);

await new Promise((resolve) => setTimeout(resolve, 800));
tap(0.47);
const next = await waitLog("verified-preparation");
assert.match(next, /prepare-selection bundle=/);
assert.doesNotMatch(next, new RegExp(`prepare-selection bundle=${staged[1]}`));
await fs.writeFile(path.join(output, "b-then-c-check.logcat.txt"), next);
results.push({case: "unconfirmed-B-does-not-reenable-B", passed: true});
console.log("unconfirmed-B-does-not-reenable-B passed");

adb(["shell", "am", "force-stop", app]);
adb(["logcat", "-c"]);
adb([
  "shell",
  "am",
  "start",
  "-n",
  `${app}/.ControllerProbeActivity`,
  "--es",
  "scenario",
  "readiness-race",
]);
const race = await waitLog("queuedReadyRejected=true");
await fs.writeFile(path.join(output, "fatal-readiness-race.logcat.txt"), race);
results.push({case: "fatal-vs-ready-ordering", passed: true});
console.log("fatal-vs-ready-ordering passed");

const receipts = path.join(android, "../.hot-updater/ota/receipts");
const server = spawn("python3", ["-m", "http.server", "18793", "--bind", "127.0.0.1"], {
  cwd: receipts,
  stdio: "ignore",
});
try {
  adb(["reverse", "tcp:18793", "tcp:18793"]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  adb(["shell", "am", "force-stop", app]);
  adb(["logcat", "-c"]);
  adb([
    "shell",
    "am",
    "start",
    "-n",
    `${app}/.InstallProbeActivity`,
    "--es",
    "scenario",
    "bad-hash",
    "--es",
    "receiptUrl",
    "http://127.0.0.1:18793/react-android-B-sdk3-managed-zip.json",
  ]);
  const rejected = await waitLog("PROBE_REJECT");
  assert.match(rejected, /PROBE_REJECT/);
  await fs.writeFile(path.join(output, "corrupt-hash-reject.logcat.txt"), rejected);
  results.push({case: "corrupt-hash-reject", passed: true});
  console.log("corrupt-hash-reject passed");
} finally {
  server.kill();
}

await fs.writeFile(path.join(output, "summary.json"), JSON.stringify({serial, results}, null, 2));
console.log(JSON.stringify({output, passed: results.length, results}, null, 2));
