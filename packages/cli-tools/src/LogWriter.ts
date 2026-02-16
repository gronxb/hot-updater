import fs from "fs";
import path from "path";
import { getCwd } from "./cwd";
import { p } from "./prompts";

export type HotUpdaterLogWriter = {
  logFilePath: string | null;
  writeLine: (line: string) => void;
  writeError: (error: unknown) => void;
  close: () => Promise<void>;
};

const initializedLogFilesInProcess = new Set<string>();

const stripAnsi = (value: string) => {
  let result = "";

  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "\u001b") {
      result += value[i];
      continue;
    }

    i += 1;

    if (i >= value.length) {
      break;
    }

    if (value[i] !== "[") {
      continue;
    }

    while (i < value.length) {
      const codePoint = value.charCodeAt(i);
      if (codePoint >= 0x40 && codePoint <= 0x7e) {
        break;
      }
      i += 1;
    }
  }

  return result;
};

const createTimestamp = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  return `${month}${date}${hour}${minute}`;
};

const sanitizeFileNamePart = (value: string) => {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
};

export const createLogWriter = async ({
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

    stream.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      p.log.warn(`Failed to write build logs: ${message}`);
    });

    const writeLine = (line: string) => {
      if (!stream.writable || stream.destroyed) {
        return;
      }
      const plainLine = stripAnsi(line).replace(/\r/g, "");
      stream.write(`${plainLine}\n`);
    };

    const writeError = (error: unknown) => {
      if (error instanceof Error) {
        const message = error.stack ?? error.message;
        for (const line of message.split("\n")) {
          if (line.trim()) {
            writeLine(line);
          }
        }
        return;
      }

      writeLine(String(error));
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

    return { logFilePath, writeLine, writeError, close };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.warn(`Failed to initialize build log file: ${message}`);

    return {
      logFilePath: null,
      writeLine: () => {},
      writeError: () => {},
      close: async () => {},
    };
  }
};
