// Private simulator acceptance probes against the real release host and compiler outputs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [udid, mode = "baseline"] = process.argv.slice(2);
assert(udid, "Pass the reserved simulator UDID");
const ios = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(ios, "../../..");
const app = "com.hotupdater.lynxexample";
const session = "lynx-ios";
const exec = (command, args) =>
  execFileSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
const container = exec("xcrun", [
  "simctl",
  "get_app_container",
  udid,
  app,
  "data",
]).trim();
const installed = exec("xcrun", [
  "simctl",
  "get_app_container",
  udid,
  app,
  "app",
]).trim();
const home = path.join(
  container,
  "Library/Application Support/HotUpdaterLynxSpike",
);
const output = path.join(ios, ".probe-results", `${Date.now()}-${mode}`);
await fs.mkdir(output, { recursive: true });
const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const events = async () =>
  (await fs.readFile(path.join(home, "events.jsonl"), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const results = [];
function device(args) {
  return JSON.parse(
    exec("agent-device", [...args, "--session", session, "--json"]),
  );
}
function close() {
  device(["close", app]);
}
async function open(name, selection, flags = [], expected = "confirmed") {
  close();
  await fs.writeFile(path.join(home, "launch.json"), JSON.stringify(selection));
  const offset = (await events()).length;
  const opened = device([
    "open",
    app,
    "--platform",
    "ios",
    "--udid",
    udid,
    "--foreground",
    ...flags.map((flag) => `--launch-args=${flag}`),
  ]);
  assert(opened.success, JSON.stringify(opened));
  let rows;
  for (let n = 0; n < 40; n++) {
    rows = (await events()).slice(offset);
    if (expected ? rows.some((row) => row.event === expected) : n >= 6) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (expected)
    assert(
      rows.some((row) => row.event === expected),
      `${name}: missing ${expected}: ${rows.map((row) => row.event)}`,
    );
  const snapshot = device(["snapshot", "-i"]);
  await fs.writeFile(
    path.join(output, `${name}.events.json`),
    JSON.stringify(rows, null, 2),
  );
  await fs.writeFile(
    path.join(output, `${name}.snapshot.json`),
    JSON.stringify(snapshot, null, 2),
  );
  const selected = rows.find((row) => row.event === "processSelected");
  const journal =
    selected?.journal && selected.journal !== "unavailable"
      ? await json(selected.journal).catch(() => null)
      : null;
  await fs.writeFile(
    path.join(output, `${name}.journal.json`),
    JSON.stringify(journal, null, 2),
  );
  results.push({
    name,
    events: rows.map((row) => row.event),
    selected: selected?.launch,
    journalFile: selected?.journal,
  });
  process.stdout.write(`${name}: ${rows.map((row) => row.event).join(", ")}\n`);
  return { rows, journal, selected, snapshot };
}
async function embedded(framework, scope) {
  return {
    ...(await json(path.join(installed, "Embedded", `${framework}-A.json`))),
    scope,
  };
}
async function candidate(framework, variant, scope) {
  const source = `examples/lynx/.hot-updater/g1/${framework}/${variant}`;
  const staged = JSON.parse(
    exec(process.execPath, [
      "scripts/lynx-g1-stage.mjs",
      "--source",
      source,
      "--output",
      "examples/lynx/.hot-updater/g1-staged/ios",
      "--entry",
      "main.lynx.bundle",
      "--platform",
      "ios",
      "--runtime-id",
      "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-spike-v2",
    ]),
  );
  const release = `${framework}/${staged.bundleId}`;
  await fs.mkdir(path.join(home, "releases", framework), { recursive: true });
  await fs.cp(staged.buildPath, path.join(home, "releases", release), {
    recursive: true,
  });
  return {
    release,
    entry: staged.entry,
    bundleId: staged.bundleId,
    releaseId: staged.releaseId,
    manifestFileHash: staged.manifestFileHash,
    embedded: "false",
    scope,
    requiredResources: JSON.stringify([
      "assets/probe.png",
      "assets/probe.ttf",
      "assets/bootstrap.js",
    ]),
  };
}
const unique = `g1-${mode}-${randomUUID()}`;
const event = (rows, name) => rows.find((row) => row.event === name);
try {
  if (mode === "dynamic") {
    for (const framework of ["react", "vue", "octane"]) {
      for (const variant of ["A", "B"]) {
        const selection = await candidate(framework, `${variant}-dynamic-managed`, `${unique}-${framework}`);
        selection.requiredResources = JSON.stringify(["assets/probe.png", "assets/probe.ttf", "dynamic/component.lynx.bundle"]);
        const response = await open(`${framework}-${variant}-dynamic`, selection);
        assert(response.rows.some(row => row.event === "resourceValidated" && row.path === "dynamic/component.lynx.bundle"));
        assert(response.rows.some(row => row.event === "fontDecoded"));
        device(["screenshot", path.join(output, `${framework}-${variant}-dynamic.png`)]);
      }
    }
  } else if (mode === "http") {
    for (const framework of ["react", "vue", "octane"]) {
      const selection = await candidate(framework, "A-http-managed", `${unique}-${framework}`);
      selection.requiredResources = JSON.stringify(["assets/probe.png"]);
      const response = await open(`${framework}-http`, selection);
      device(["screenshot", path.join(output, `${framework}-http.png`)]);
      assert.equal(event(response.rows, "confirmed").launch.releaseId, selection.releaseId);
    }
  } else if (mode === "baseline") {
    for (const framework of ["react", "vue", "octane"]) {
      const scope = `${unique}-${framework}`;
      const a = await embedded(framework, scope);
      const b = await candidate(framework, "B-external2-managed", scope);
      for (const [slot, selection] of [
        ["A", a],
        ["B", b],
      ]) {
        const { rows, journal } = await open(`${framework}-${slot}`, selection);
        assert.equal(
          event(rows, "confirmed").launch.releaseId,
          selection.releaseId,
        );
        for (const resource of JSON.parse(selection.requiredResources))
          assert(
            rows.some(
              (row) =>
                row.event === "resourceValidated" && row.path === resource,
            ),
          );
        assert(event(rows, "fontDecoded"));
        assert(
          event(rows, "getLaunchInfo") &&
            event(rows, "probeError") &&
            event(rows, "notifyReady"),
        );
        assert(
          rows.indexOf(event(rows, "confirmed")) >
            rows.indexOf(event(rows, "fontDecoded")),
        );
        assert.equal(journal.confirmed.releaseId, selection.releaseId);
        assert.equal(journal.pending, undefined);
        device(["screenshot", path.join(output, `${framework}-${slot}.png`)]);
        if (slot === "B") {
          const restart = await open(`${framework}-B-restart`, selection);
          assert(!event(restart.rows, "attempt"));
          assert.equal(
            restart.journal.confirmed.releaseId,
            selection.releaseId,
          );
          const returned = await open(`${framework}-A-return`, a);
          assert.equal(returned.journal.confirmed.releaseId, a.releaseId);
          assert(
            returned.rows.some(
              (row) =>
                row.event === "fontDecoded" &&
                row.postScriptName === "Inter-Regular",
            ),
          );
        }
      }
    }
  } else if (mode === "recovery") {
    const a = await embedded("react", unique);
    await open("confirmed-A", a);
    const b = await candidate(
      "react",
      "B-unconfirmed-external2-managed",
      unique,
    );
    const c = await candidate(
      "react",
      "C-unconfirmed-external2-managed",
      unique,
    );
    const first = await open("unconfirmed-B", b, [], "firstContent");
    assert.equal(first.journal.pending.selection.releaseId, b.releaseId);
    const second = await open("unconfirmed-C", c, [], "firstContent");
    assert.deepEqual(second.journal.excludedReleaseIds, [b.releaseId]);
    assert.equal(second.journal.pending.selection.releaseId, c.releaseId);
    const recovered = await open("recovered-A", c);
    assert.deepEqual(recovered.journal.excludedReleaseIds, [
      b.releaseId,
      c.releaseId,
    ]);
    assert.deepEqual(recovered.journal.crashedBundleIds, []);
    assert.equal(recovered.selected.launch.releaseId, a.releaseId);
    const refused = await open("excluded-B", b);
    assert(event(refused.rows, "candidateExcluded"));
    assert.equal(refused.selected.launch.releaseId, a.releaseId);
    const republished = { ...b, releaseId: randomUUID() };
    const retried = await open(
      "same-bytes-new-release",
      republished,
      [],
      "firstContent",
    );
    assert.equal(
      retried.journal.pending.selection.releaseId,
      republished.releaseId,
    );
    assert.deepEqual(retried.journal.excludedReleaseIds, [
      b.releaseId,
      c.releaseId,
    ]);
    const recoveredAgain = await open("recovered-again", a);
    assert.deepEqual(recoveredAgain.journal.excludedReleaseIds, [
      b.releaseId,
      c.releaseId,
      republished.releaseId,
    ]);
  } else if (mode === "contexts") {
    const b = await candidate(
      "react",
      "A-double-ready-external2-managed",
      unique,
    );
    const normal = await open("double-ready", b);
    assert.equal(
      normal.rows.filter((row) => row.event === "confirmed").length,
      1,
    );
    assert.equal(
      normal.rows.filter((row) => row.event === "notifyReady").length,
      2,
    );
    const secondary = await open(
      "secondary-context",
      b,
      ["--spike-secondary-first", "--spike-secondary"],
      "readyRejected",
    );
    assert(event(secondary.rows, "secondaryDeferred"));
    assert.equal(
      secondary.rows.filter((row) => row.event === "confirmed").length,
      1,
    );
    const duplicate = await open(
      "duplicate-primary",
      { ...b, releaseId: randomUUID() },
      ["--spike-duplicate-primary"],
    );
    assert(event(duplicate.rows, "duplicatePrimaryRejected"));
    assert.equal(
      duplicate.rows.filter((row) => row.event === "attempt").length,
      1,
    );
    const noPrimary = await open("no-primary", b, ["--spike-no-primary"], null);
    assert(
      !event(noPrimary.rows, "attempt") && !event(noPrimary.rows, "resource"),
    );
    const fresh = { ...b, releaseId: randomUUID() };
    const retired = await open(
      "retired-primary",
      fresh,
      ["--spike-delay-ready", "--spike-retire-primary"],
      "readyRejected",
    );
    assert(event(retired.rows, "contextRetired"));
    assert(!event(retired.rows, "confirmed"));
    assert.equal(retired.journal.pending.selection.releaseId, fresh.releaseId);
    const recovered = await open("retired-recovery", b);
    assert(recovered.journal.excludedReleaseIds.includes(fresh.releaseId));
  } else if (mode === "metadata") {
    const a = await embedded("react", unique);
    await open("confirmed-A", a);
    const b = await candidate("react", "B-external2-managed", unique);
    const artifact = path.join(home, "releases", b.release);
    async function changeMetadata(change) {
      const file = path.join(artifact, "hot-updater-lynx.json");
      const metadata = await json(file);
      change(metadata);
      await fs.writeFile(file, JSON.stringify(metadata));
      const manifestFile = path.join(artifact, "manifest.json");
      const manifest = await json(manifestFile);
      manifest.assets["hot-updater-lynx.json"].fileHash = hash(
        await fs.readFile(file),
      );
      await fs.writeFile(manifestFile, JSON.stringify(manifest));
      b.manifestFileHash = hash(await fs.readFile(manifestFile));
    }
    close();
    await changeMetadata((value) => {
      value.runtimeId = "unknown-native-runtime";
    });
    const rejected = await open("incompatible-B", b);
    assert(event(rejected.rows, "candidateRejected"));
    assert.equal(rejected.selected.launch.releaseId, a.releaseId);
    assert(!event(rejected.rows, "attempt"));
    const cached = await open("incompatible-cache-hit", b);
    assert(event(cached.rows, "compatibilityCacheHit"));
    assert.deepEqual(cached.journal.excludedReleaseIds, []);
    assert.deepEqual(cached.journal.crashedBundleIds, []);
    close();
    await changeMetadata((value) => {
      value.schemaVersion = true;
    });
    const boolean = await open("boolean-schema", b);
    assert(
      event(boolean.rows, "candidateRejected") &&
        !event(boolean.rows, "compatibilityCacheHit"),
    );
    close();
    await changeMetadata((value) => {
      delete value.schemaVersion;
    });
    const missing = await open("missing-schema", b);
    assert(event(missing.rows, "candidateRejected"));
    close();
    await changeMetadata((value) => {
      value.schemaVersion = 2;
    });
    assert(
      event((await open("unsupported-schema", b)).rows, "candidateRejected"),
    );
    close();
    await changeMetadata((value) => {
      value.schemaVersion = 1;
      value.platform = "android";
    });
    assert(event((await open("wrong-platform", b)).rows, "candidateRejected"));
    close();
    await changeMetadata((value) => {
      value.platform = "ios";
      delete value.runtimeId;
    });
    assert(event((await open("missing-runtime", b)).rows, "candidateRejected"));
    close();
    await changeMetadata((value) => {
      value.schemaVersion = 1;
      value.runtimeId =
        "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-spike-v2";
    });
    const corrected = await open("changed-artifact-admitted", b);
    assert.equal(corrected.selected.launch.releaseId, b.releaseId);
    assert(event(corrected.rows, "attempt"));
  } else if (mode === "failures") {
    const a = await embedded("react", unique);
    await open("confirmed-A", a);
    const b = await candidate("react", "B-external2-managed", unique);
    close();
    const root = path.join(home, "releases", b.release);
    await fs.writeFile(
      path.join(root, b.entry),
      "G1 intentionally invalid native template\n",
    );
    const manifest = await json(path.join(root, "manifest.json"));
    manifest.assets[b.entry].fileHash = hash(
      await fs.readFile(path.join(root, b.entry)),
    );
    await fs.writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify(manifest),
    );
    b.manifestFileHash = hash(
      await fs.readFile(path.join(root, "manifest.json")),
    );
    const fatal = await open(
      "invalid-native-template",
      b,
      [],
      "startupFailure",
    );
    assert(fatal.journal.crashedBundleIds.includes(b.bundleId));
    assert.equal(
      fatal.rows.filter((row) => row.event === "startupFailure").length,
      1,
    );
    assert.deepEqual(fatal.journal.excludedReleaseIds, []);
    const retry = await open("fatal-bundle-new-release", {
      ...b,
      releaseId: randomUUID(),
    });
    assert(event(retry.rows, "candidateExcluded"));
    assert.equal(retry.selected.launch.releaseId, a.releaseId);
    const unlisted = await candidate("react", "B-external2-managed", unique);
    close();
    const unlistedRoot = path.join(home, "releases", unlisted.release);
    const unlistedManifest = await json(
      path.join(unlistedRoot, "manifest.json"),
    );
    delete unlistedManifest.assets["assets/bootstrap.js"];
    await fs.writeFile(
      path.join(unlistedRoot, "manifest.json"),
      JSON.stringify(unlistedManifest),
    );
    unlisted.manifestFileHash = hash(
      await fs.readFile(path.join(unlistedRoot, "manifest.json")),
    );
    unlisted.requiredResources = JSON.stringify([
      "assets/probe.png",
      "assets/probe.ttf",
    ]);
    const denied = await open(
      "unlisted-existing-script",
      unlisted,
      [],
      "startupFailure",
    );
    assert(event(denied.rows, "resourceError"));
    assert(
      !denied.rows.some(
        (row) => row.event === "resource" && row.url.endsWith("bootstrap.js"),
      ),
    );
    const runtime = await candidate(
      "react",
      "B-fatal-external2-managed",
      unique,
    );
    const unknown = await open(
      "unhandled-background-error",
      runtime,
      [],
      "runtimeError",
    );
    assert.equal(event(unknown.rows, "runtimeError").fatal, false);
    assert(!unknown.journal.crashedBundleIds.includes(runtime.bundleId));
    const recovered = await open("unknown-error-recovery", a);
    assert(recovered.journal.excludedReleaseIds.includes(runtime.releaseId));
  } else if (mode === "capacity") {
    const a = await embedded("react", unique);
    const confirmed = await open("confirmed-A", a);
    const b = await candidate("react", "B-external2-managed", unique);
    const stale = await open("stale-selection", {
      ...b,
      selectionRevision: "-1",
    });
    assert(event(stale.rows, "staleSelectionRejected"));
    assert(!event(stale.rows, "attempt"));
    close();
    const seeded = await json(confirmed.selected.journal);
    seeded.excludedReleaseIds = Array.from({ length: 128 }, () => randomUUID());
    await fs.writeFile(confirmed.selected.journal, JSON.stringify(seeded));
    const refused = await open("capacity-preserves-confirmed", b);
    assert(event(refused.rows, "exclusionCapacityReached"));
    assert.deepEqual(
      refused.journal.excludedReleaseIds,
      seeded.excludedReleaseIds,
    );
    assert.equal(refused.selected.launch.releaseId, a.releaseId);
    assert(!event(refused.rows, "attempt"));
    close();
    const fullCache = await json(confirmed.selected.journal);
    fullCache.excludedReleaseIds = [];
    fullCache.incompatibleArtifacts = Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [
        `seed-${index}`,
        "test-only incompatible artifact",
      ]),
    );
    await fs.writeFile(confirmed.selected.journal, JSON.stringify(fullCache));
    const cacheRefused = await open("cache-capacity-preserves-confirmed", b);
    assert(event(cacheRefused.rows, "compatibilityCacheCapacityReached"));
    assert.deepEqual(
      cacheRefused.journal.incompatibleArtifacts,
      fullCache.incompatibleArtifacts,
    );
    assert.equal(cacheRefused.selected.launch.releaseId, a.releaseId);
    assert(!event(cacheRefused.rows, "attempt"));
  } else throw new Error(`Unknown mode ${mode}`);
} finally {
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  process.stdout.write(`Evidence: ${output}\n`);
}
