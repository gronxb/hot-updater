import { BuildFailedError } from "@hot-updater/cli-tools";
import { ExecaError, execa } from "execa";

import { createXcodebuildLogger } from "./createXcodebuildLogger";

let cachedXcbeautifyAvailability: boolean | null = null;
const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
type KillableProcess = {
  kill: (signal?: number | NodeJS.Signals) => boolean;
};

export const isXcbeautifyAvailable = async () => {
  if (cachedXcbeautifyAvailability !== null) {
    return cachedXcbeautifyAvailability;
  }

  try {
    await execa("which", ["xcbeautify"]);
    cachedXcbeautifyAvailability = true;
    return true;
  } catch {
    cachedXcbeautifyAvailability = false;
    return false;
  }
};

const createRawXcodebuildProcess = ({
  args,
  env,
  sourceDir,
}: {
  args: string[];
  env?: Record<string, string>;
  sourceDir: string;
}) => {
  return execa("xcodebuild", args, {
    cwd: sourceDir,
    all: true,
    // The output streams to the log file; buffered, it would fill the
    // error's message.
    buffer: false,
    env: { ...process.env, ...env, NSUnbufferedIO: "YES" },
  });
};

const createXcbeautifyProcess = ({ cwd }: { cwd: string }) => {
  return execa("xcbeautify", [], {
    cwd,
    all: true,
    buffer: false,
  });
};

/** Why xcodebuild failed, without its command line. */
const describeFailure = (error: unknown) => {
  if (error instanceof ExecaError) {
    if (error.signal) return `xcodebuild was stopped by ${error.signal}.`;
    if (error.exitCode !== undefined) {
      return `xcodebuild exited with code ${error.exitCode}.`;
    }
  }
  return error instanceof Error ? error.message : String(error);
};

export const runXcodebuildWithLogging = async ({
  args,
  env,
  sourceDir,
  successMessage,
  failureMessage,
  logPrefix,
}: {
  args: string[];
  env?: Record<string, string>;
  failureMessage: string;
  logPrefix: string;
  sourceDir: string;
  successMessage: string;
}) => {
  const useXcbeautify = await isXcbeautifyAvailable();
  const logger = createXcodebuildLogger({ logPrefix });
  await logger.start();
  const activeProcesses: KillableProcess[] = [];
  const terminateActiveProcesses = () => {
    for (const activeProcess of activeProcesses) {
      activeProcess.kill();
    }
  };
  // Forward termination from parent CLI to running native build processes.
  for (const signal of TERMINATION_SIGNALS) {
    process.once(signal, terminateActiveProcesses);
  }

  try {
    // Keep both processes as direct children so Ctrl+C cleanup can kill them explicitly.
    const xcodebuildProcess = createRawXcodebuildProcess({
      args,
      env,
      sourceDir,
    });
    activeProcesses.push(xcodebuildProcess);
    const xcodebuildOutput = xcodebuildProcess.all ?? xcodebuildProcess.stdout;

    let xcbeautifyProcess: ReturnType<typeof createXcbeautifyProcess> | null =
      null;
    if (useXcbeautify && xcodebuildOutput) {
      xcbeautifyProcess = createXcbeautifyProcess({ cwd: sourceDir });
      activeProcesses.push(xcbeautifyProcess);
    }

    // The log file and the failure summary read xcodebuild's raw output;
    // xcbeautify's only shows progress.
    const logging = xcodebuildOutput
      ? logger.processStream(xcodebuildOutput, {
          display: xcbeautifyProcess
            ? (xcbeautifyProcess.all ?? xcbeautifyProcess.stdout ?? undefined)
            : undefined,
        })
      : Promise.resolve();
    const xcbeautifyInput = xcbeautifyProcess?.stdin;
    if (xcodebuildOutput && xcbeautifyInput) {
      // xcbeautify exiting early must not end xcodebuild's output, which
      // the log still reads.
      xcbeautifyInput.on("error", () => {
        xcodebuildOutput.unpipe(xcbeautifyInput);
      });
      xcodebuildOutput.pipe(xcbeautifyInput);
    }

    // Settled together: xcodebuild exits before xcbeautify and the log
    // finish reading its output, and its failure must wait for them.
    const [xcodebuildResult, loggingResult] = await Promise.allSettled([
      xcodebuildProcess,
      logging,
      // Only formats the terminal's progress.
      xcbeautifyProcess,
    ]);
    if (xcodebuildResult.status === "rejected") {
      throw xcodebuildResult.reason;
    }
    if (loggingResult.status === "rejected") {
      throw loggingResult.reason;
    }

    logger.stop(successMessage);
  } catch (error) {
    logger.writeError(error);
    logger.stop(failureMessage, false);
    throw new BuildFailedError(`${failureMessage}: ${describeFailure(error)}`, {
      logPath: logger.logPath,
      summary: logger.failureSummary,
      cause: error,
    });
  } finally {
    for (const signal of TERMINATION_SIGNALS) {
      process.off(signal, terminateActiveProcesses);
    }
    await logger.close();
  }
};
