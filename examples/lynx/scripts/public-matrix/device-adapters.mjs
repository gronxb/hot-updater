import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const APP_ID = "com.hotupdater.lynxmatrix";
const EVENT_MARKER = "HOT_UPDATER_MATRIX_EVENT ";

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`,
    );
  }
  return result.stdout.trim();
}

async function sha256(file) {
  return createHash("sha256")
    .update(await fsp.readFile(file))
    .digest("hex");
}

function parseEvents(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = line.indexOf(EVENT_MARKER);
    const trimmed = line.trim();
    const encoded =
      marker >= 0
        ? line.slice(marker + EVENT_MARKER.length).trim()
        : trimmed.startsWith("{")
          ? trimmed
          : "";
    if (!encoded) continue;
    let event;
    try {
      event = JSON.parse(encoded);
    } catch {
      throw new Error(`Malformed matrix event JSON: ${encoded}`);
    }
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.event !== "string"
    ) {
      throw new Error(`Invalid matrix event: ${encoded}`);
    }
    events.push(event);
  }
  return events;
}

class IOSAdapter {
  constructor({ deviceId, binaryPath, resultsDir, session }) {
    this.deviceId = deviceId;
    this.binaryPath = binaryPath;
    this.resultsDir = resultsDir;
    this.session = session;
    this.logStartedAt = new Date().toISOString();
  }

  async sourceBinaryHash() {
    const info = JSON.parse(
      run("plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        path.join(this.binaryPath, "Info.plist"),
      ]),
    );
    return sha256(path.join(this.binaryPath, info.CFBundleExecutable));
  }

  installedExecutable() {
    const installed = run("xcrun", [
      "simctl",
      "get_app_container",
      this.deviceId,
      APP_ID,
      "app",
    ]);
    const info = JSON.parse(
      run("plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        path.join(installed, "Info.plist"),
      ]),
    );
    return path.join(installed, info.CFBundleExecutable);
  }

  async installedBinaryHash() {
    return sha256(this.installedExecutable());
  }

  install() {
    run("xcrun", ["simctl", "install", this.deviceId, this.binaryPath]);
  }

  terminate() {
    spawnSync("xcrun", ["simctl", "terminate", this.deviceId, APP_ID], {
      encoding: "utf8",
    });
  }

  dataContainer() {
    return run("xcrun", [
      "simctl",
      "get_app_container",
      this.deviceId,
      APP_ID,
      "data",
    ]);
  }

  resetCell() {
    this.terminate();
    this.logStartedAt = new Date(Date.now() - 1000).toISOString();
    fs.rmSync(
      path.join(
        this.dataContainer(),
        "Library/Application Support/HotUpdaterLynxPublic",
      ),
      { recursive: true, force: true },
    );
  }

  launch(framework, channel) {
    this.terminate();
    this.device([
      "open",
      APP_ID,
      "--platform",
      "ios",
      "--udid",
      this.deviceId,
      "--foreground",
      `--launch-args=--ota-framework=${framework} --ota-channel=${channel}`,
    ]);
    return this.processId();
  }

  processId() {
    const executable = this.installedExecutable();
    const output = run("xcrun", [
      "simctl",
      "spawn",
      this.deviceId,
      "ps",
      "-axo",
      "pid=,command=",
    ]);
    const row = output.split("\n").find((line) => line.includes(executable));
    const processId = row?.trim().split(/\s+/)[0];
    if (!processId || !/^\d+$/.test(processId)) {
      throw new Error(`Could not find the running iOS process for ${APP_ID}`);
    }
    return processId;
  }

  device(args) {
    const output = execFileSync(
      "agent-device",
      [...args, "--session", this.session, "--json"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(output);
  }

  async waitForText(expected, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = this.device(["snapshot", "-i"]);
      if (
        last.data.nodes.some((node) =>
          String(node.label ?? "").includes(expected),
        )
      ) {
        return;
      }
      await wait(250);
    }
    throw new Error(`Missing iOS text ${expected}: ${JSON.stringify(last)}`);
  }

  clickText(text) {
    this.device(["find", text, "click"]);
  }

  screenshot(name) {
    this.device(["screenshot", path.join(this.resultsDir, `${name}.png`)]);
  }

  readEvents() {
    const file = path.join(
      this.dataContainer(),
      "Library/Application Support/HotUpdaterLynxPublic/matrix-events.jsonl",
    );
    return parseEvents(
      fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "",
    );
  }

  readStates() {
    const stores = path.join(
      this.dataContainer(),
      "Library/Application Support/HotUpdaterLynxPublic/stores",
    );
    if (!fs.existsSync(stores)) return [];
    return fs
      .readdirSync(stores)
      .map((name) => path.join(stores, name, "state.json"))
      .filter((file) => fs.existsSync(file))
      .map((file) => ({
        file,
        value: JSON.parse(fs.readFileSync(file, "utf8")),
      }));
  }

  readNativeLogs() {
    return run("xcrun", [
      "simctl",
      "spawn",
      this.deviceId,
      "log",
      "show",
      "--style",
      "compact",
      "--start",
      this.logStartedAt,
      "--predicate",
      'eventMessage CONTAINS "HotUpdater"',
    ]);
  }
}

class AndroidAdapter {
  constructor({ deviceId, binaryPath, resultsDir }) {
    this.deviceId = deviceId;
    this.binaryPath = binaryPath;
    this.resultsDir = resultsDir;
  }

  adb(args, options) {
    return run("adb", ["-s", this.deviceId, ...args], options);
  }

  sourceBinaryHash() {
    return sha256(this.binaryPath);
  }

  async installedBinaryHash() {
    const packagePath = this.adb(["shell", "pm", "path", APP_ID])
      .split("\n")
      .map((line) => line.replace(/^package:/, "").trim())
      .find((line) => line.endsWith("base.apk"));
    if (!packagePath) throw new Error("Could not locate the installed APK");
    return this.adb(["shell", "sha256sum", packagePath]).split(/\s+/)[0];
  }

  install() {
    this.adb(["install", "-r", this.binaryPath]);
  }

  terminate() {
    this.adb(["shell", "am", "force-stop", APP_ID]);
  }

  resetCell() {
    this.terminate();
    this.adb(["shell", "pm", "clear", APP_ID]);
    this.adb(["logcat", "-c"]);
  }

  launch(framework, channel) {
    this.terminate();
    this.adb([
      "shell",
      "am",
      "start",
      "-n",
      `${APP_ID}/.MatrixActivity`,
      "--es",
      "framework",
      framework,
      "--es",
      "channel",
      channel,
    ]);
    return this.processId();
  }

  processId() {
    const processId = this.adb(["shell", "pidof", APP_ID]).split(/\s+/)[0];
    if (!/^\d+$/.test(processId)) {
      throw new Error(
        `Could not find the running Android process for ${APP_ID}`,
      );
    }
    return processId;
  }

  hierarchy() {
    this.adb(["shell", "uiautomator", "dump", "/sdcard/lynx-matrix.xml"]);
    return this.adb(["shell", "cat", "/sdcard/lynx-matrix.xml"]);
  }

  async waitForText(expected, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      last = this.hierarchy();
      if (last.includes(`text=\"${expected}`) || last.includes(expected))
        return;
      await wait(250);
    }
    throw new Error(`Missing Android text ${expected}: ${last.slice(-4000)}`);
  }

  clickText(text) {
    const xml = this.hierarchy();
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const node = xml.match(
      new RegExp(
        `<node[^>]*(?:text|content-desc)=\"${escaped}\"[^>]*bounds=\"\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]\"[^>]*/>`,
      ),
    );
    if (!node) throw new Error(`Could not find Android action ${text}`);
    const x = Math.floor((Number(node[1]) + Number(node[3])) / 2);
    const y = Math.floor((Number(node[2]) + Number(node[4])) / 2);
    this.adb(["shell", "input", "tap", String(x), String(y)]);
  }

  screenshot(name) {
    const bytes = execFileSync(
      "adb",
      ["-s", this.deviceId, "exec-out", "screencap", "-p"],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    );
    fs.writeFileSync(path.join(this.resultsDir, `${name}.png`), bytes);
  }

  readEvents() {
    return parseEvents(this.adb(["logcat", "-d", "-s", "HotUpdaterLynx:I"]));
  }

  readStates() {
    const listed = spawnSync(
      "adb",
      [
        "-s",
        this.deviceId,
        "shell",
        "run-as",
        APP_ID,
        "find",
        "files/hot-updater-lynx/scopes",
        "-name",
        "state.json",
      ],
      { encoding: "utf8" },
    );
    if (listed.status !== 0) return [];
    return listed.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) => ({
        file,
        value: JSON.parse(this.adb(["shell", "run-as", APP_ID, "cat", file])),
      }));
  }

  readNativeLogs() {
    return this.adb(["logcat", "-d", "-s", "HotUpdaterLynx:I"]);
  }
}

export function createDeviceAdapter(platform, options) {
  if (platform === "ios") return new IOSAdapter(options);
  if (platform === "android") return new AndroidAdapter(options);
  throw new Error(`Unsupported Lynx matrix platform: ${platform}`);
}

export { EVENT_MARKER, parseEvents };
