import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A path as typed or dropped on a terminal: quotes, `\ `, and `~` undone. */
export const readTypedPath = (typed: string) => {
  const trimmed = typed.trim().replace(/^(['"])(.*)\1$/u, "$2");
  const unescaped = trimmed.replace(/\\ /gu, " ");
  return path.resolve(
    unescaped === "~" || unescaped.startsWith("~/")
      ? path.join(os.homedir(), unescaped.slice(1))
      : unescaped,
  );
};

export const isReadableFile = (file: string) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};
