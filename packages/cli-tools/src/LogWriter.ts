import fs from "fs";
import path from "path";
import type { Readable } from "stream";
import { getCwd } from "./cwd";
import { p } from "./prompts";

export type HotUpdaterLogWriter = {
  logFilePath: string | null;
  writeStream: (input: Readable) => Promise<void>;
  writeError: (error: unknown) => void;
  close: () => Promise<void>;
};

const initializedLogFilesInProcess = new Set<string>();

export const stripAnsi = (value: string) => {
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

    i += 1;

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

const normalizeChunk = ({ chunk }: { chunk: unknown }) => {
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString();
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString();
  }

  return String(chunk);
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
  logFilePath,
}: {
  prefix: string;
  logFilePath?: string;
}): Promise<HotUpdaterLogWriter> => {
  try {
    const logDir = path.join(getCwd(), ".hot-updater", "log");

    const sanitizedPrefix = sanitizeFileNamePart(prefix);
    const resolvedLogFilePath =
      logFilePath ??
      path.join(logDir, `${createTimestamp()}-${sanitizedPrefix}.log`);

    await fs.promises.mkdir(path.dirname(resolvedLogFilePath), {
      recursive: true,
    });

    const fileOpenFlag = initializedLogFilesInProcess.has(resolvedLogFilePath)
      ? "a"
      : "w";
    const stream = fs.createWriteStream(resolvedLogFilePath, {
      flags: fileOpenFlag,
    });

    if (!initializedLogFilesInProcess.has(resolvedLogFilePath)) {
      initializedLogFilesInProcess.add(resolvedLogFilePath);
    }

    stream.write(`[${new Date().toISOString()}] ${sanitizedPrefix}\n`);

    stream.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      p.log.warn(`Failed to write build logs: ${message}`);
    });

    const writeChunk = (value: string | Buffer) => {
      if (!stream.writable || stream.destroyed) {
        return;
      }
      const plainText = stripAnsi(normalizeChunk({ chunk: value })).replace(
        /\r/g,
        "",
      );
      stream.write(plainText);
    };

    const writeStream = async (input: Readable) => {
      for await (const chunk of input) {
        writeChunk(normalizeChunk({ chunk }));
      }
    };

    const writeError = (error: unknown) => {
      const message =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      writeChunk(`${message}\n`);
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

    return {
      logFilePath: resolvedLogFilePath,
      writeStream,
      writeError,
      close,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.warn(`Failed to initialize build log file: ${message}`);

    return {
      logFilePath: null,
      writeStream: async () => {},
      writeError: () => {},
      close: async () => {},
    };
  }
};
