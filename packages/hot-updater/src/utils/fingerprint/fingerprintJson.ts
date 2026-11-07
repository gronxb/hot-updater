import fs from "node:fs";
import path from "node:path";

import type { FingerprintFile } from "./common";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type JsonObject = { [key: string]: Json };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A platform's record as fingerprint.json keeps it: the provider's result
 * without `debugInfo`, which an adapter may return for its own diagnostics
 * and which nothing reads back. Throws on a record that isn't one, such as
 * a platform missing from a hand-merged file.
 */
const recordPlatform = (value: Json | undefined): JsonObject => {
  if (
    !isObject(value) ||
    typeof value["hash"] !== "string" ||
    !Array.isArray(value["sources"])
  ) {
    throw new Error("not a fingerprint record");
  }
  return {
    ...value,
    sources: value["sources"].map((source) => {
      if (!isObject(source)) throw new Error("not a fingerprint source");
      const { debugInfo: _debugInfo, ...recorded } = source;
      return recorded;
    }),
  };
};

/** The data fingerprint.json records: each platform's fingerprint and the inputs. */
const recordFile = (value: Json): JsonObject => {
  if (!isObject(value)) throw new Error("not a fingerprint.json");
  return {
    ios: recordPlatform(value["ios"]),
    android: recordPlatform(value["android"]),
    ...(value["inputs"] === undefined ? {} : { inputs: value["inputs"] }),
  };
};

/**
 * A comparison key for recorded data: object keys sorted, array order and
 * value types kept, so `nativeVersion: 1` and `"1"` differ and so do a
 * missing `extraSources` and an empty one.
 */
const stableStringify = (value: Json): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/** How a fingerprint.json is laid out: what a rewrite keeps. */
interface FileStyle {
  indent: string;
  eol: string;
  finalNewline: boolean;
}

/** What a new fingerprint.json gets: JSON.stringify's two spaces, a final newline. */
const DEFAULT_STYLE: FileStyle = {
  indent: "  ",
  eol: "\n",
  finalNewline: true,
};

/**
 * The style of an existing file, as npm keeps package.json's: the first
 * indented line's indentation, two spaces when there is none or it mixes
 * tabs and spaces, its line endings, and whether it ends with one.
 */
const detectStyle = (text: string): FileStyle => {
  const indent = /\n([ \t]+)\S/.exec(text)?.[1];
  return {
    indent: indent && /^( +|\t+)$/.test(indent) ? indent : DEFAULT_STYLE.indent,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    finalNewline: text.endsWith("\n"),
  };
};

const format = (value: Json, { indent, eol, finalNewline }: FileStyle) =>
  JSON.stringify(value, null, indent).replace(/\n/g, eol) +
  (finalNewline ? eol : "");

/**
 * Writes `fingerprint` to `<cwd>/fingerprint.json` unless the file already
 * records the same data, however it is formatted, so builds and prebuilds
 * don't rewrite an equal file. A rewrite keeps the file's indentation, line
 * endings, and final newline; a new file, or one that can't be read as a
 * fingerprint.json, such as one with merge conflict markers, gets two-space
 * JSON with a final newline. Returns whether it wrote.
 */
export const writeFingerprintJsonIfChanged = async (
  cwd: string,
  fingerprint: FingerprintFile,
): Promise<boolean> => {
  const file = path.join(cwd, "fingerprint.json");
  // As JSON.stringify writes them: binary contents, undefined fields.
  const next = recordFile(JSON.parse(JSON.stringify(fingerprint)) as Json);
  const existing = await fs.promises.readFile(file, "utf8").catch(() => null);
  let style = DEFAULT_STYLE;
  if (existing !== null) {
    try {
      if (
        stableStringify(recordFile(JSON.parse(existing) as Json)) ===
        stableStringify(next)
      ) {
        return false;
      }
      style = detectStyle(existing);
    } catch {
      // Not a fingerprint.json: replace it in the default style.
    }
  }
  await fs.promises.writeFile(file, format(next, style));
  return true;
};
