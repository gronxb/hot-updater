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

const WIDTH = 80;

const isPrimitive = (value: Json) =>
  value === null || typeof value !== "object";

/**
 * JSON with two-space indentation and a final newline, with an array of
 * strings or numbers, such as `reasons` or `extraSources`, on one line when
 * it fits in 80 columns: what Prettier 3 and oxfmt print for JSON at
 * printWidth 80, for ASCII text, so formatting the file leaves it unchanged.
 */
export const formatFingerprintJson = (value: Json): string => {
  const emit = (
    node: Json,
    indent: number,
    prefix: string,
    comma: boolean,
  ): string => {
    const pad = "  ".repeat(indent);
    const end = comma ? "," : "";
    const lines = (items: string[], open: string, close: string) =>
      `${prefix}${open}\n${items.map((item) => `${pad}  ${item}`).join("\n")}\n${pad}${close}${end}`;
    if (Array.isArray(node)) {
      if (node.length === 0) return `${prefix}[]${end}`;
      if (node.every(isPrimitive)) {
        const items = node.map((item) => JSON.stringify(item));
        const flat = `${prefix}[${items.join(", ")}]${end}`;
        if (pad.length + flat.length <= WIDTH) return flat;
        return lines(
          items.map((item, index) =>
            index < items.length - 1 ? `${item},` : item,
          ),
          "[",
          "]",
        );
      }
      return lines(
        node.map((item, index) =>
          emit(item, indent + 1, "", index < node.length - 1),
        ),
        "[",
        "]",
      );
    }
    if (isObject(node)) {
      const keys = Object.keys(node);
      if (keys.length === 0) return `${prefix}{}${end}`;
      return lines(
        keys.map((key, index) =>
          emit(
            node[key]!,
            indent + 1,
            `${JSON.stringify(key)}: `,
            index < keys.length - 1,
          ),
        ),
        "{",
        "}",
      );
    }
    return `${prefix}${JSON.stringify(node)}${end}`;
  };
  return `${emit(value, 0, "", false)}\n`;
};

/**
 * Writes `fingerprint` to `<cwd>/fingerprint.json` unless the file already
 * records the same data, however it is formatted, so builds, prebuilds, and
 * formatters don't rewrite it back and forth. A file that can't be read as
 * a fingerprint.json, such as one with merge conflict markers, is replaced.
 * Returns whether it wrote.
 */
export const writeFingerprintJsonIfChanged = async (
  cwd: string,
  fingerprint: FingerprintFile,
): Promise<boolean> => {
  const file = path.join(cwd, "fingerprint.json");
  // As JSON.stringify writes them: binary contents, undefined fields.
  const next = recordFile(JSON.parse(JSON.stringify(fingerprint)) as Json);
  const existing = await fs.promises.readFile(file, "utf8").catch(() => null);
  if (existing !== null) {
    let same = false;
    try {
      same =
        stableStringify(recordFile(JSON.parse(existing) as Json)) ===
        stableStringify(next);
    } catch {
      // Not a fingerprint.json: replace it.
    }
    if (same) return false;
  }
  await fs.promises.writeFile(file, formatFingerprintJson(next));
  return true;
};
