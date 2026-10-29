import { BuildFailedError } from "@hot-updater/cli-tools";
import { ExecaError, execa } from "execa";

import { createXcodebuildLogger } from "./createXcodebuildLogger";
import { formatCommand } from "./formatCommand";

const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
type KillableProcess = {
  kill: (signal?: number | NodeJS.Signals) => boolean;
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

/**
 * Runs xcodebuild as a step titled `title`: its live line shows the build's
 * phase, the log file keeps the command and the whole output, and a failure
 * prints the output's errors and the log's path on stderr.
 */
export const runXcodebuildWithLogging = async ({
  args,
  env,
  sourceDir,
  title,
  successMessage,
  failureMessage,
  logPrefix,
  logFilePath,
  header = [],
}: {
  args: string[];
  env?: Record<string, string>;
  /** The step's title while it runs, such as `Archiving App`. */
  title: string;
  failureMessage: string;
  logPrefix: string;
  /** The log to append to, such as the archive's for its export. */
  logFilePath?: string;
  /** Lines the log starts with, before the command line. */
  header?: string[];
  sourceDir: string;
  successMessage: string;
}): Promise<{ logFilePath: string | null }> => {
  const logger = createXcodebuildLogger({ logPrefix, logFilePath });
  await logger.start({
    title,
    header: [...header, `$ ${formatCommand(["xcodebuild", ...args])}`, ""],
  });
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
    const xcodebuildProcess = createRawXcodebuildProcess({
      args,
      env,
      sourceDir,
    });
    activeProcesses.push(xcodebuildProcess);
    const xcodebuildOutput = xcodebuildProcess.all ?? xcodebuildProcess.stdout;

    // The log file, the failure summary, and the step's phase read
    // xcodebuild's raw output.
    const logging = xcodebuildOutput
      ? logger.processStream(xcodebuildOutput)
      : Promise.resolve();

    // Settled together: xcodebuild exits before the log finishes reading
    // its output, and its failure must wait for it.
    const [xcodebuildResult, loggingResult] = await Promise.allSettled([
      xcodebuildProcess,
      logging,
    ]);
    if (xcodebuildResult.status === "rejected") {
      throw xcodebuildResult.reason;
    }
    if (loggingResult.status === "rejected") {
      throw loggingResult.reason;
    }

    logger.stop(successMessage);
    return { logFilePath: logger.logFilePath };
  } catch (error) {
    logger.writeError(error);
    const reason = describeFailure(error);
    // One line says which step failed and why: `Archive failed · xcodebuild
    // exited with code 65`.
    logger.stop(`${failureMessage} · ${reason.replace(/\.$/, "")}`, false);
    throw new BuildFailedError(`${failureMessage}: ${reason}`, {
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
