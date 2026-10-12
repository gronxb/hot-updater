import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function appleLogMessages(raw, complete) {
  const lines = raw.split("\n");
  const tail = lines.pop();
  if (complete && tail) {
    throw new Error("Native log capture ended with an incomplete record");
  }
  if (lines[0]?.startsWith("Filtering the log data using ")) lines.shift();
  if (complete) {
    // On SIGINT Apple appends a blank separator and a terminal count record.
    while (lines.at(-1) === "") lines.pop();
    let summary;
    try {
      summary = JSON.parse(lines.pop());
    } catch {
      throw new Error(
        "Native log capture has no valid Apple completion summary",
      );
    }
    if (lines.at(-1) === "") lines.pop();
    if (
      summary?.finished !== 1 ||
      summary.count !== lines.length ||
      Object.keys(summary).sort().join(",") !== "count,finished"
    ) {
      throw new Error(
        "Native log capture has an invalid Apple completion count",
      );
    }
  }
  return lines
    .map((line) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error("Native log capture contains malformed Apple NDJSON");
      }
      if (record?.eventType === "lossEvent" || record?.unreliable === true) {
        throw new Error("Native log capture reported dropped records");
      }
      if (
        typeof record?.eventMessage !== "string" ||
        typeof record.timestamp !== "string" ||
        !Number.isSafeInteger(record.processID) ||
        record.processID <= 0
      ) {
        throw new Error("Native log capture contains an invalid Apple record");
      }
      return `[${record.timestamp} pid=${record.processID}] ${record.eventMessage}\n`;
    })
    .join("");
}

// File descriptors keep draining the producer while synchronous device/build
// commands block the runner's event loop. Do not replace them with JS pipes.
export async function startNativeLogCapture({
  command,
  args,
  directory,
  writeMarker,
  apple = false,
  timeoutMs = 10_000,
}) {
  const token = `HOT_UPDATER_CAPTURE_${randomUUID()}`;
  const startMarker = `${token}_START`;
  const endMarker = `${token}_END`;
  const logPath = path.join(directory, apple ? "native.ndjson" : "native.log");
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
  let forced = false;
  const stopSignal = apple ? "SIGINT" : "SIGTERM";
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
      `${JSON.stringify({ status, command, args, pid: child.pid, startMarker, endMarker, terminal, forced, error: failure?.message }, null, 2)}\n`,
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
    const stderr = fs
      .readFileSync(stderrPath, "utf8")
      .split("\n")
      .filter((line) => {
        // The simulator cannot resolve the host account. Keep the diagnostic
        // in the raw stderr file; it does not report stream loss or disconnect.
        return !(
          apple &&
          line === `getpwuid_r did not find a match for uid ${process.getuid()}`
        );
      })
      .join("\n")
      .trim();
    if (stderr) throw new Error(`Native log capture stderr: ${stderr}`);
    const raw = fs.readFileSync(logPath, "utf8");
    const logs = apple ? appleLogMessages(raw, completed) : raw;
    if (
      /\bchatty\s*:.*\b(?:identical|expire)|\b(?:dropped|lost)\s+\d+\s+(?:log\s+)?(?:messages|lines)|logcat:.*(?:unexpected EOF|read failure)/i.test(
        logs,
      )
    ) {
      throw new Error("Native log capture reported dropped records");
    }
    return logs;
  };
  const waitForMarker = async (marker, waitMs = timeoutMs) => {
    const deadline = Date.now() + waitMs;
    do {
      // Also observe a pending child exit after a synchronous marker command.
      await delay(25);
      const logs = read();
      if (logs.includes(marker)) return true;
    } while (Date.now() < deadline);
    return false;
  };
  const mark = async (marker) => {
    await writeMarker(marker);
    if (!(await waitForMarker(marker))) {
      throw new Error(`Native log capture did not observe ${marker}`);
    }
  };
  const stop = () => {
    stopping ??= (async () => {
      if (!terminal) child.kill(stopSignal);
      const killTimer = setTimeout(() => {
        forced = true;
        child.kill("SIGKILL");
      }, 2_000);
      try {
        await closed;
      } finally {
        clearTimeout(killTimer);
      }
      if (
        forced ||
        (terminal.code !== 0 && (apple || terminal.signal !== stopSignal))
      ) {
        failure ??= new Error("Native log capture did not shut down cleanly");
      }
      record("incomplete");
    })();
    return stopping;
  };
  try {
    record("starting");
    if (apple) {
      // log stream has no backlog: establish its subscription before START.
      const deadline = Date.now() + timeoutMs;
      let ready = false;
      while (!ready && Date.now() < deadline) {
        const marker = `${token}_READY_${randomUUID()}`;
        await writeMarker(marker);
        ready = await waitForMarker(marker, 250);
      }
      if (!ready) throw new Error("Native log capture did not become ready");
    }
    await mark(startMarker);
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
      await mark(marker);
      const logs = read();
      const end = logs.indexOf("\n", logs.indexOf(marker));
      return logs.slice(0, end < 0 ? logs.length : end + 1);
    },
    async finish() {
      try {
        read();
        await mark(endMarker);
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
        record("complete");
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
