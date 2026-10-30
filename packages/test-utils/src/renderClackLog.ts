import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

import * as clack from "@clack/prompts";

/** The `p` calls a command prints with, as a spec's stand-ins record them. */
export type ClackLogMethod =
  | "message"
  | "info"
  | "success"
  | "step"
  | "warn"
  | "error"
  | "note"
  | "intro"
  | "outro"
  | "cancel";

/** One call: the method and its arguments, such as a note's title. */
export type ClackLogCall = readonly [
  method: ClackLogMethod,
  ...args: readonly unknown[],
];

/** A stand-in that records its calls, such as vitest's `vi.fn()`. */
interface RecordedFunction {
  readonly mock: {
    readonly calls: readonly (readonly unknown[])[];
    readonly invocationCallOrder: readonly number[];
  };
}

const METHODS: ReadonlySet<string> = new Set<ClackLogMethod>([
  "message",
  "info",
  "success",
  "step",
  "warn",
  "error",
  "note",
  "intro",
  "outro",
  "cancel",
]);

/**
 * The calls a spec's stand-ins for `p.log` (and `p.note`, `p.outro`, ...)
 * recorded, in the order the command made them.
 */
export const recordedClackCalls = (
  ...stubs: readonly object[]
): ClackLogCall[] =>
  stubs
    .flatMap((stub) =>
      Object.entries(
        stub as Record<string, Partial<RecordedFunction> | undefined>,
      ).flatMap(([method, fn]) => {
        const mock = fn?.mock;
        if (!mock || !METHODS.has(method)) return [];
        return mock.calls.map(
          (args, index) =>
            [
              mock.invocationCallOrder[index] ?? 0,
              [method as ClackLogMethod, ...args] as const,
            ] as const,
        );
      }),
    )
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call);

/**
 * The lines the calls print through `@clack/prompts`, without colors, on a
 * terminal `columns` wide: clack wraps only a note, so any other line wider
 * than the terminal is one the terminal wraps.
 */
export const renderClackLog = (
  calls: readonly ClackLogCall[],
  { columns = 80 }: { columns?: number } = {},
): string[] => {
  let text = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        text += String(chunk);
        done();
      },
    }),
    { columns, isTTY: false },
  );
  const options = { output, withGuide: true };
  for (const [method, ...args] of calls) {
    const [message = "", title = ""] = args.map((arg) =>
      arg === undefined ? "" : String(arg),
    );
    if (method === "note") clack.note(message, title, options);
    else if (method === "intro") clack.intro(message, options);
    else if (method === "outro") clack.outro(message, options);
    else if (method === "cancel") clack.cancel(message, options);
    else clack.log[method](message, options);
  }
  return stripVTControlCharacters(text).replace(/\n+$/, "").split("\n");
};

const graphemes = new Intl.Segmenter();
const WIDE_PATTERN =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}/u;

/**
 * The columns a line takes in a terminal, as East Asian Width counts them,
 * not its bytes or code units: `│`, `■`, and `…` take one each, a wide
 * character or an emoji two, and a combining mark none. The CLI keeps its
 * own count; this one is the specs' measure of it.
 */
export const displayColumns = (line: string): number =>
  [...graphemes.segment(stripVTControlCharacters(line))].reduce(
    (columns, { segment }) =>
      columns +
      (/^[\p{M}\p{Cf}\p{Cc}]+$/u.test(segment)
        ? 0
        : WIDE_PATTERN.test(segment)
          ? 2
          : 1),
    0,
  );

/**
 * The lines wider than `columns` display columns, which a terminal that
 * wide wraps, but for a line that is one word after clack's gutter, such
 * as a URL, which no line break could shorten.
 */
export const linesWiderThan = (
  lines: readonly string[],
  columns = 80,
): string[] =>
  lines.filter(
    (line) =>
      displayColumns(line) > columns && /\s/u.test(line.slice(3).trim()),
  );
