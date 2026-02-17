import { execa } from "execa";
import type { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createXcodebuildLogger } from "./createXcodebuildLogger";

let cachedXcbeautifyAvailability: boolean | null = null;
const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
// Stream pipeline can close early while children are being terminated.
const IGNORED_PIPELINE_ERROR_CODES = ["EPIPE", "ERR_STREAM_PREMATURE_CLOSE"];
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
  sourceDir,
}: {
  args: string[];
  sourceDir: string;
}) => {
  return execa("xcodebuild", args, {
    cwd: sourceDir,
    all: true,
    env: { ...process.env, NSUnbufferedIO: "YES" },
  });
};

const createXcbeautifyProcess = ({ cwd }: { cwd: string }) => {
  return execa("xcbeautify", [], {
    cwd,
    all: true,
  });
};

const getErrorCode = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "";
  }

  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : "";
};

const shouldIgnorePipelineError = (error: unknown) => {
  const errorCode = getErrorCode(error);
  return IGNORED_PIPELINE_ERROR_CODES.includes(errorCode);
};

const createXcodebuildOutputPipingPromise = async ({
  xcodebuildOutput,
  xcbeautifyInput,
}: {
  xcodebuildOutput: NodeJS.ReadableStream;
  xcbeautifyInput: NodeJS.WritableStream;
}) => {
  try {
    return await pipeline(xcodebuildOutput, xcbeautifyInput);
  } catch (error) {
    // Ignore expected stream-close races while shutting down child processes.
    if (shouldIgnorePipelineError(error)) {
      return;
    }

    throw error;
  }
};

const processOutputStream = async ({
  outputStream,
  logger,
}: {
  logger: ReturnType<typeof createXcodebuildLogger>;
  outputStream: Readable | null | undefined;
}) => {
  if (!outputStream) {
    return;
  }

  // BuildLogger parses high-signal lines and writes full output to log files.
  await logger.processStream(outputStream);
};

export const runXcodebuildWithLogging = async ({
  args,
  sourceDir,
  successMessage,
  failureMessage,
  logPrefix,
}: {
  args: string[];
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
    if (useXcbeautify) {
      // Keep both processes as direct children so Ctrl+C cleanup can kill them explicitly.
      const xcodebuildProcess = createRawXcodebuildProcess({ args, sourceDir });
      const xcbeautifyProcess = createXcbeautifyProcess({ cwd: sourceDir });
      activeProcesses.push(xcodebuildProcess, xcbeautifyProcess);

      const xcodebuildOutput =
        xcodebuildProcess.all ?? xcodebuildProcess.stdout;
      const xcbeautifyInput = xcbeautifyProcess.stdin;
      if (!xcodebuildOutput || !xcbeautifyInput) {
        throw new Error("Failed to pipe xcodebuild output into xcbeautify");
      }

      const pipingPromise = createXcodebuildOutputPipingPromise({
        xcodebuildOutput,
        xcbeautifyInput,
      });

      await processOutputStream({
        logger,
        outputStream: xcbeautifyProcess.all ?? xcbeautifyProcess.stdout,
      });

      await Promise.all([xcbeautifyProcess, xcodebuildProcess, pipingPromise]);
    } else {
      const xcodebuildProcess = createRawXcodebuildProcess({ args, sourceDir });
      activeProcesses.push(xcodebuildProcess);

      await processOutputStream({
        logger,
        outputStream: xcodebuildProcess.all ?? xcodebuildProcess.stdout,
      });

      await xcodebuildProcess;
    }

    logger.stop(successMessage);
  } catch (error) {
    logger.writeError(error);
    logger.stop(failureMessage, false);
    throw error;
  } finally {
    for (const signal of TERMINATION_SIGNALS) {
      process.off(signal, terminateActiveProcesses);
    }
    await logger.close();
  }
};
