import fs from "fs";
import path from "path";
import { getCwd } from "./cwd";
import { p } from "./prompts";

type HotUpdaterLogWriter = {
  logFilePath: string | null;
  writeLine: (line: string) => void;
  close: () => Promise<void>;
};

const initializedLogFilesInProcess = new Set<string>();

const createTimestamp = () => {
  const now = new Date();
  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  return `${year}${month}${date}-${hour}${minute}`;
};

const sanitizeFileNamePart = (value: string) => {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
};

export const createHotUpdaterLogWriter = async ({
  prefix,
}: {
  prefix: string;
}): Promise<HotUpdaterLogWriter> => {
  try {
    const logDir = path.join(getCwd(), ".hot-updater", "log");
    await fs.promises.mkdir(logDir, { recursive: true });

    const sanitizedPrefix = sanitizeFileNamePart(prefix);
    const logFileName = `${createTimestamp()}-${sanitizedPrefix}.log`;
    const logFilePath = path.join(logDir, logFileName);
    const fileOpenFlag = initializedLogFilesInProcess.has(logFilePath)
      ? "a"
      : "w";
    const stream = fs.createWriteStream(logFilePath, { flags: fileOpenFlag });

    if (!initializedLogFilesInProcess.has(logFilePath)) {
      initializedLogFilesInProcess.add(logFilePath);
    }

    stream.write(`[${new Date().toISOString()}] ${sanitizedPrefix}\n`);

    stream.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      p.log.warn(`Failed to write build logs: ${message}`);
    });

    const writeLine = (line: string) => {
      if (!stream.writable || stream.destroyed) {
        return;
      }
      stream.write(`${line}\n`);
    };

    const close = () => {
      return new Promise<void>((resolve) => {
        if (!stream.writable || stream.destroyed) {
          resolve();
          return;
        }
        stream.end(() => resolve());
      });
    };

    return { logFilePath, writeLine, close };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.warn(`Failed to initialize build log file: ${message}`);

    return {
      logFilePath: null,
      writeLine: () => {},
      close: async () => {},
    };
  }
};
