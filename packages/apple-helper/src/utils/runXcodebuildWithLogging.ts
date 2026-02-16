import { execa } from "execa";
import { createXcodebuildLogger } from "./createXcodebuildLogger";

let cachedXcbeautifyAvailability: boolean | null = null;

const XCODEBUILD_XCBEAUTIFY_SCRIPT =
  'set -o pipefail; NSUnbufferedIO=YES xcodebuild "$@" 2>&1 | xcbeautify; exit ${PIPESTATUS[0]}';

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

const createXcodebuildWithXcbeautifyProcess = ({
  args,
  sourceDir,
}: {
  args: string[];
  sourceDir: string;
}) => {
  return execa("bash", ["-c", XCODEBUILD_XCBEAUTIFY_SCRIPT, "--", ...args], {
    cwd: sourceDir,
    all: true,
  });
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
  });
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

  try {
    const process = useXcbeautify
      ? createXcodebuildWithXcbeautifyProcess({ args, sourceDir })
      : createRawXcodebuildProcess({ args, sourceDir });

    const outputStream = process.all ?? process.stdout;
    if (outputStream) {
      await logger.processStream(outputStream);
    }
    await process;

    logger.stop(successMessage);
  } catch (error) {
    logger.writeError(error);
    logger.stop(failureMessage, false);
    throw error;
  } finally {
    await logger.close();
  }
};
