import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertNoManagedResourceEngineErrors } from "./managed-resource-errors";
import { startNativeLogCapture } from "./public-matrix/native-log-capture.mjs";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function producer(options: { discardEnd?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lynx-capture-"));
  cleanups.push(async () =>
    fs.rmSync(directory, { recursive: true, force: true }),
  );
  const input = path.join(directory, "input.jsonl");
  const finished = path.join(directory, "burst-finished");
  const latestWindow = path.join(directory, "latest-window.log");
  fs.writeFileSync(input, "");
  const send = (value: Record<string, unknown>) =>
    fs.appendFileSync(input, `${JSON.stringify(value)}\n`);
  const capture = await startNativeLogCapture({
    command: process.execPath,
    args: [
      "-e",
      `
      const fs = require('node:fs');
      const [input, finished, latestWindow] = process.argv.slice(1);
      let cursor = 0;
      const log = (value, pid = 1111) => fs.writeSync(1, '10-10 07:00:00.001  ' + pid + '  1234 I HotUpdaterLynx: ' + value + '\\n');
      setInterval(() => {
        const lines = fs.readFileSync(input, 'utf8').trim().split('\\n').filter(Boolean);
        for (; cursor < lines.length; cursor++) {
          const value = JSON.parse(lines[cursor]);
          if (value.stderr) fs.writeSync(2, value.stderr);
          if (value.delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, value.delay);
          if (value.line) log(value.line);
          if (value.exit) process.exit(0);
          if (value.marker) log(value.marker);
          if (value.burst) {
            log('engine-error fatal=false code=302 message={"error_code":302,"type":"font","src":"hot-updater:///assets/probe.ttf"}');
            for (let i = 0; i < 4096; i++) log('clean-' + 'x'.repeat(1024), 2222);
            const tail = '10-10 07:00:00.001  2222  1234 I HotUpdaterLynx: clean final window\\n';
            fs.writeSync(1, tail);
            fs.writeFileSync(latestWindow, tail);
            fs.writeFileSync(finished, 'done');
          }
        }
      }, 10);
    `,
      input,
      finished,
      latestWindow,
    ],
    directory,
    timeoutMs: 1_000,
    writeMarker: (marker: string) => {
      if (!(options.discardEnd && marker.endsWith("_END"))) send({ marker });
    },
  });
  cleanups.push(() => capture.close());
  return { capture, directory, send, finished, latestWindow };
}

describe("whole-cell native log capture", () => {
  it("waits for queued transfer and failure records before a phase checkpoint", async () => {
    const { capture, send } = await producer();
    send({ delay: 150, line: "archive-fallback unexpectedly selected" });
    expect(capture.read()).not.toContain("archive-fallback");
    const logs = await capture.checkpoint();
    expect(logs).toContain("archive-fallback unexpectedly selected");
    await capture.finish();
  });

  it("retains an early error across a new PID, log rollover and a blocking command", async () => {
    const { capture, send, finished, latestWindow } = await producer();
    send({ burst: true });
    const blocked = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const fs = require('node:fs');
      const end = Date.now() + 5000;
      while (!fs.existsSync(process.argv[1]) && Date.now() < end) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      process.exit(fs.existsSync(process.argv[1]) ? 0 : 1);
    `,
        finished,
      ],
      { timeout: 6_000 },
    );
    // A JS-drained stdout pipe deadlocks the producer here.
    expect(blocked.status).toBe(0);
    const logs = await capture.finish();
    expect(logs).toContain("1111  1234 I HotUpdaterLynx: engine-error");
    expect(logs).toContain("2222  1234 I HotUpdaterLynx: clean final window");
    expect(() =>
      assertNoManagedResourceEngineErrors(
        fs.readFileSync(latestWindow, "utf8"),
      ),
    ).not.toThrow();
    expect(() => assertNoManagedResourceEngineErrors(logs)).toThrow("302");
  });

  it("fails when the producer exits even if its last window is clean", async () => {
    const { capture, directory, send } = await producer();
    send({ line: "clean final window", exit: true });
    await expect(capture.finish()).rejects.toThrow(
      "exited before its end marker",
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(directory, "native-log-capture.json"),
          "utf8",
        ),
      ).status,
    ).toBe("incomplete");
  });

  it("requires a real end marker before accepting and joins the producer", async () => {
    const { capture, directory } = await producer({ discardEnd: true });
    await expect(capture.finish()).rejects.toThrow("did not observe");
    const receipt = JSON.parse(
      fs.readFileSync(path.join(directory, "native-log-capture.json"), "utf8"),
    );
    expect(receipt.status).toBe("incomplete");
    expect(receipt.terminal).toBeDefined();
  });

  it.each([
    { stderr: "logcat: Unexpected EOF!" },
    { line: "chatty: uid=10234 expire 42 lines" },
  ])("rejects explicit disconnect or drop evidence: %j", async (event) => {
    const { capture, send } = await producer();
    send(event);
    await expect(capture.finish()).rejects.toThrow(/stderr|dropped records/);
  });
});
