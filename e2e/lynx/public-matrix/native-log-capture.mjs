import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// File descriptors keep draining the producer while synchronous device/build
// commands block the runner's event loop. Do not replace them with JS pipes.
export async function startNativeLogCapture({
  command,
  args,
  directory,
  writeMarker,
  timeoutMs = 10_000,
}) {
  const token = `HOT_UPDATER_CAPTURE_${randomUUID()}`;
  const startMarker = `${token}_START`;
  const endMarker = `${token}_END`;
  const logPath = path.join(directory, "native.log");
  const stderrPath = path.join(directory, "native-log-stderr.log");
  const receiptPath = path.join(directory, "native-log-capture.json");
  const stdout = fs.openSync(logPath, "wx");
  let child;
  try {
    const stderr = fs.openSync(stderrPath, "wx");
    try {
      child = spawn(command, args, { stdio: ["ignore", stdout, stderr] });
    } finally {
      fs.closeSync(stderr);
    }
  } finally {
    fs.closeSync(stdout);
  }
  let failure;
  let terminal;
  let completed = false;
  let stopping;
  const closed = new Promise((resolve) => {
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      terminal = { code, signal };
      resolve();
    });
  });
  const record = (status) => {
    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify({ status, command, args, pid: child.pid, startMarker, endMarker, terminal, error: failure?.message }, null, 2)}\n`,
    );
  };
  const read = () => {
    if (failure) throw failure;
    if (
      !completed &&
      (terminal || child.exitCode !== null || child.signalCode !== null)
    ) {
      throw new Error("Native log capture exited before its end marker");
    }
    const stderr = fs.readFileSync(stderrPath, "utf8").trim();
    if (stderr) throw new Error(`Native log capture stderr: ${stderr}`);
    const logs = fs.readFileSync(logPath, "utf8");
    if (
      /\bchatty\s*:.*\b(?:identical|expire)|\b(?:dropped|lost)\s+\d+\s+(?:log\s+)?(?:messages|lines)|logcat:.*(?:unexpected EOF|read failure)/i.test(
        logs,
      )
    ) {
      throw new Error("Native log capture reported dropped records");
    }
    return logs;
  };
  const waitForMarker = async (marker) => {
    const deadline = Date.now() + timeoutMs;
    do {
      // Also observe a pending child exit after a synchronous marker command.
      await delay(25);
      const logs = read();
      if (logs.includes(marker)) return;
    } while (Date.now() < deadline);
    throw new Error(`Native log capture did not observe ${marker}`);
  };
  const stop = () => {
    stopping ??= (async () => {
      if (!terminal) child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try {
        await closed;
      } finally {
        clearTimeout(killTimer);
      }
      record(completed ? "complete" : "incomplete");
    })();
    return stopping;
  };
  try {
    record("starting");
    await writeMarker(startMarker);
    await waitForMarker(startMarker);
    record("recording");
  } catch (error) {
    failure = error;
    await stop();
    throw error;
  }
  return {
    read,
    async checkpoint() {
      const marker = `${token}_CHECKPOINT_${randomUUID()}`;
      read();
      await writeMarker(marker);
      await waitForMarker(marker);
      const logs = read();
      return logs.slice(0, logs.indexOf(marker) + marker.length);
    },
    async finish() {
      try {
        read();
        await writeMarker(endMarker);
        await waitForMarker(endMarker);
        completed = true;
        await stop();
        const logs = read();
        if (
          logs.split(startMarker).length !== 2 ||
          logs.split(endMarker).length !== 2 ||
          logs.indexOf(startMarker) >= logs.indexOf(endMarker)
        ) {
          throw new Error("Native log capture boundaries are invalid");
        }
        return logs;
      } catch (error) {
        completed = false;
        failure = error;
        await stop();
        record("incomplete");
        throw error;
      }
    },
    close: stop,
  };
}
