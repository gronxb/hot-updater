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

async function producer(
  options: {
    apple?: boolean;
    discardEnd?: boolean;
    discardFirstReady?: boolean;
    shutdown?:
      | "nonzero"
      | "partial"
      | "forced"
      | "bad-count"
      | "missing-summary";
  } = {},
) {
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
      const [input, finished, latestWindow, encodedOptions] = process.argv.slice(1);
      const options = JSON.parse(encodedOptions);
      let cursor = 0;
      let count = 0;
      const log = (value, pid = 1111) => {
        count++;
        fs.writeSync(1, options.apple
        ? JSON.stringify({ eventType: 'logEvent', eventMessage: value, formatString: value, timestamp: '2026-10-12 07:00:00.001+0900', processID: pid }) + '\\n'
        : '10-10 07:00:00.001  ' + pid + '  1234 I HotUpdaterLynx: ' + value + '\\n');
      };
      if (options.apple) fs.writeSync(1, 'Filtering the log data using "test"\\n');
      if (options.apple || options.shutdown) process.on(options.apple ? 'SIGINT' : 'SIGTERM', () => {
        if (options.shutdown === 'forced') return;
        if (options.shutdown === 'partial') fs.writeSync(1, '{"eventMessage":');
        else if (options.apple && options.shutdown !== 'missing-summary') {
          fs.writeSync(1, '\\n' + JSON.stringify({ count: count + (options.shutdown === 'bad-count' ? 1 : 0), finished: 1 }) + '\\n\\n');
        }
        process.exit(options.shutdown === 'nonzero' ? 7 : 0);
      });
      setInterval(() => {
        const lines = fs.readFileSync(input, 'utf8').trim().split('\\n').filter(Boolean);
        for (; cursor < lines.length; cursor++) {
          const value = JSON.parse(lines[cursor]);
          if (value.stderr) fs.writeSync(2, value.stderr);
          if (value.raw) fs.writeSync(1, value.raw);
          if (value.delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, value.delay);
          if (value.line) log(value.line);
          if (value.exit) process.exit(0);
          if (value.marker) log(value.marker);
          if (value.burst) {
            log('engine-error fatal=false code=302 message={"error_code":302,"type":"font","src":"hot-updater:///assets/probe.ttf"}');
            for (let i = 0; i < 4096; i++) log('clean-' + 'x'.repeat(1024), 2222);
            const tail = '10-10 07:00:00.001  2222  1234 I HotUpdaterLynx: clean final window\\n';
            log('clean final window', 2222);
            fs.writeFileSync(latestWindow, tail);
            fs.writeFileSync(finished, 'done');
          }
        }
      }, 10);
    `,
      input,
      finished,
      latestWindow,
      JSON.stringify(options),
    ],
    directory,
    apple: options.apple,
    timeoutMs: 1_000,
    writeMarker: (marker: string) => {
      if (options.discardFirstReady && marker.includes("_READY_")) {
        options.discardFirstReady = false;
        return;
      }
      if (!(options.discardEnd && marker.endsWith("_END"))) send({ marker });
    },
  });
  cleanups.push(() => capture.close());
  return { capture, directory, send, finished, latestWindow };
}

describe.each([false, true])(
  "whole-cell native log capture (Apple=%s)",
  (apple) => {
    it("waits for queued transfer and failure records before a phase checkpoint", async () => {
      const { capture, send } = await producer({ apple });
      send({ delay: 150, line: "archive-fallback unexpectedly selected" });
      expect(capture.read()).not.toContain("archive-fallback");
      const logs = await capture.checkpoint();
      expect(logs).toContain("archive-fallback unexpectedly selected");
      await capture.finish();
    });

    it("retains an early error across a new PID, log rollover and a blocking command", async () => {
      const { capture, send, finished, latestWindow } = await producer({
        apple,
      });
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
      expect(logs).toContain(
        apple
          ? "pid=1111] engine-error"
          : "1111  1234 I HotUpdaterLynx: engine-error",
      );
      expect(logs).toContain(
        apple
          ? "pid=2222] clean final window"
          : "2222  1234 I HotUpdaterLynx: clean final window",
      );
      expect(() =>
        assertNoManagedResourceEngineErrors(
          fs.readFileSync(latestWindow, "utf8"),
        ),
      ).not.toThrow();
      expect(() => assertNoManagedResourceEngineErrors(logs)).toThrow("302");
    });

    it("fails when the producer exits even if its last window is clean", async () => {
      const { capture, directory, send } = await producer({ apple });
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
      const { capture, directory } = await producer({
        apple,
        discardEnd: true,
      });
      await expect(capture.finish()).rejects.toThrow("did not observe");
      const receipt = JSON.parse(
        fs.readFileSync(
          path.join(directory, "native-log-capture.json"),
          "utf8",
        ),
      );
      expect(receipt.status).toBe("incomplete");
      expect(receipt.terminal).toBeDefined();
    });

    it.each([
      { stderr: "logcat: Unexpected EOF!" },
      { line: "chatty: uid=10234 expire 42 lines" },
    ])("rejects explicit disconnect or drop evidence: %j", async (event) => {
      const { capture, send } = await producer({ apple });
      send(event);
      await expect(capture.finish()).rejects.toThrow(/stderr|dropped records/);
    });

    it.each(["nonzero", "forced"] as const)(
      "rejects %s producer shutdown after the end marker",
      async (shutdown) => {
        const { capture, directory } = await producer({ apple, shutdown });
        await expect(capture.finish()).rejects.toThrow(
          "did not shut down cleanly",
        );
        const receipt = JSON.parse(
          fs.readFileSync(
            path.join(directory, "native-log-capture.json"),
            "utf8",
          ),
        );
        expect(receipt.status).toBe("incomplete");
        expect(receipt.terminal).toEqual(
          shutdown === "nonzero"
            ? { code: 7, signal: null }
            : { code: null, signal: "SIGKILL" },
        );
        expect(receipt.forced).toBe(shutdown === "forced");
      },
    );
  },
);

describe("Apple native log capture", () => {
  it("retains the simulator's host UID lookup diagnostic without ignoring other stderr", async () => {
    const warning = `getpwuid_r did not find a match for uid ${process.getuid()}\n`;
    const { capture, directory, send } = await producer({ apple: true });
    send({ stderr: warning });
    await capture.checkpoint();
    expect(
      fs.readFileSync(path.join(directory, "native-log-stderr.log"), "utf8"),
    ).toBe(warning);
    send({ stderr: "stream disconnected\n" });
    await expect(capture.finish()).rejects.toThrow("stream disconnected");
  });

  it("does not exempt UID lookup diagnostics on Android", async () => {
    const { capture, send } = await producer();
    send({
      stderr: `getpwuid_r did not find a match for uid ${process.getuid()}\n`,
    });
    await expect(capture.finish()).rejects.toThrow("stderr");
  });

  it("establishes the live subscription before START and preserves raw NDJSON", async () => {
    const { capture, directory, send } = await producer({
      apple: true,
      discardFirstReady: true,
    });
    send({
      line: 'HOT_UPDATER_MATRIX_DIAGNOSTIC {"action":"retire","ok":true,"processId":"1111"}',
    });
    const checkpoint = await capture.checkpoint();
    expect(checkpoint).toContain(
      'DIAGNOSTIC {"action":"retire","ok":true,"processId":"1111"}',
    );
    expect(checkpoint).toMatch(/_CHECKPOINT_[^\n]+\n$/);
    const logs = await capture.finish();
    const raw = fs.readFileSync(path.join(directory, "native.ndjson"), "utf8");
    expect(raw).toContain('"processID":1111');
    expect(raw).toContain('"formatString":');
    expect(logs).not.toContain('"formatString":');
    const receipt = JSON.parse(
      fs.readFileSync(path.join(directory, "native-log-capture.json"), "utf8"),
    );
    expect(receipt.status).toBe("complete");
    expect(logs.indexOf("_READY_")).toBeLessThan(
      logs.indexOf(receipt.startMarker),
    );
    expect(receipt.terminal).toEqual({ code: 0, signal: null });
  });

  it.each([
    { raw: '{"eventType":"lossEvent"}\n', error: "dropped records" },
    { raw: '{"unreliable":true}\n', error: "dropped records" },
    { raw: "{malformed}\n", error: "malformed Apple NDJSON" },
    { raw: '{"eventMessage":"clean"}\n', error: "invalid Apple record" },
  ])("rejects unusable stream records: $error", async ({ raw, error }) => {
    const { capture, send } = await producer({ apple: true });
    send({ raw });
    await expect(capture.finish()).rejects.toThrow(error);
  });

  it("rejects a truncated record flushed during shutdown", async () => {
    const { capture } = await producer({ apple: true, shutdown: "partial" });
    await expect(capture.finish()).rejects.toThrow("incomplete record");
  });

  it.each(["bad-count", "missing-summary"] as const)(
    "requires a matching terminal Apple record count: %s",
    async (shutdown) => {
      const { capture } = await producer({ apple: true, shutdown });
      await expect(capture.finish()).rejects.toThrow(/Apple completion/);
    },
  );
});
