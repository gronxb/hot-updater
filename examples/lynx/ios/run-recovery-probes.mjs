// Public-host recovery on the Release simulator binary. No G1 placement of B.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const udid = process.argv[2];
assert(udid);
const ios = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(ios, "../../..");
const app = "com.hotupdater.lynxexample";
const exec = (cmd, args) =>
  execFileSync(cmd, args, {cwd: repo, encoding: "utf8", maxBuffer: 12 * 1024 * 1024});
const device = (args) =>
  JSON.parse(exec("agent-device", [...args, "--session", "lynx-ios", "--json"]));
const data = exec("xcrun", ["simctl", "get_app_container", udid, app, "data"]).trim();
const home = path.join(data, "Library/Application Support/HotUpdaterLynxPublic");
const output = path.join(ios, ".probe-results", `${Date.now()}-recovery`);
await fs.mkdir(output, {recursive: true});
const events = async () =>
  (await fs.readFile(path.join(home, "events.jsonl"), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
async function waitLabel(text) {
  let snapshot;
  for (let n = 0; n < 40; n++) {
    snapshot = device(["snapshot", "-i"]);
    if (snapshot.data.nodes.some((row) => row.label?.includes(text))) return snapshot;
    const failure = snapshot.data.nodes.find((row) => /failed:|failure:/i.test(row.label ?? ""));
    if (failure) throw Error(failure.label);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error(`Missing ${text}: ${JSON.stringify(snapshot)}`);
}
async function state() {
  const candidates = [];
  for (const name of await fs.readdir(path.join(home, "stores"))) {
    const file = path.join(home, "stores", name, "state.json");
    const value = JSON.parse(await fs.readFile(file, "utf8").catch(() => '{"skip":true}'));
    if (value.skip) continue;
    const raw = value.confirmed?.receipt ?? value.next?.receipt;
    if (raw && JSON.parse(Buffer.from(raw, "base64")).channel === "ota-react") {
      candidates.push({file, value, mtime: (await fs.stat(file)).mtimeMs});
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  assert(candidates.length);
  return candidates[0];
}
const open = () =>
  device([
    "open",
    app,
    "--platform",
    "ios",
    "--udid",
    udid,
    "--foreground",
    "--launch-args=--ota-framework=react",
  ]);

device(["close", app]);
await fs.rm(home, {recursive: true, force: true});
open();
await waitLabel("Bundle A ready");
device(["find", "Check update", "click"]);
await waitLabel("Update verified and ready to install.");
device(["find", "Install next launch", "click"]);
await waitLabel("Update installed. Close and reopen the app.");
const staged = JSON.parse(Buffer.from((await state()).value.next.receipt, "base64"));
device(["close", app]);
const offset = (await events()).length;
open();
let killed = false;
for (let n = 0; n < 50; n++) {
  const rows = (await events()).slice(offset);
  if (
    rows.some(
      (row) =>
        row.event === "publicBeforeEvaluation" &&
        row.state?.runningSelection?.releaseId === staged.releaseId,
    )
  ) {
    device(["close", app]);
    killed = true;
    await fs.writeFile(
      path.join(output, "unconfirmed-kill.events.json"),
      JSON.stringify(rows, null, 2),
    );
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert(killed, "Did not observe B evaluation before confirmation");
open();
await waitLabel("Bundle A ready");
const recovered = await state();
assert.equal(
  JSON.parse(Buffer.from(recovered.value.confirmed.receipt, "base64")).kind,
  "BUILTIN",
);
assert.equal(
  (recovered.value.unconfirmedReleaseIds ?? []).includes(staged.releaseId) ||
    JSON.stringify(recovered.value).includes(staged.releaseId),
  true,
);
await fs.writeFile(
  path.join(output, "unconfirmed-recovered.state.json"),
  JSON.stringify(recovered.value, null, 2),
);
device(["screenshot", path.join(output, "unconfirmed-recovered-A.png")]);
const results = [
  {case: "unconfirmed-B-recovers-to-embedded", passed: true, excludedRelease: staged.releaseId},
];
await fs.writeFile(path.join(output, "summary.json"), JSON.stringify({udid, results}, null, 2));
console.log(JSON.stringify({output, passed: results.length, results}, null, 2));
