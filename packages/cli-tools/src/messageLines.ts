import { stripVTControlCharacters } from "node:util";

import { maskSecretValues } from "./secretMasking";

/**
 * The widest line of a message the CLI prints: clack puts it after its
 * 3-column gutter (`│  `), and the whole line stays within 76 columns.
 */
export const MESSAGE_WIDTH = 73;

/**
 * The widest line in a `p.note` box, whose gutter, padding, and right edge
 * take 6 columns of the same 76.
 */
export const NOTE_WIDTH = 70;

const graphemes = new Intl.Segmenter();
/** Combining marks, format and control characters: they take no column. */
const ZERO_WIDTH = /^[\p{M}\p{Cf}\p{Cc}]+$/u;
/** East Asian wide and fullwidth characters, and emoji: two columns each. */
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}/u;

/** The columns one grapheme takes. */
const segmentWidth = (segment: string): number =>
  ZERO_WIDTH.test(segment) ? 0 : WIDE.test(segment) ? 2 : 1;

/**
 * The columns `text` takes in a terminal, without its colors: `│`, `■`,
 * and `…` take one each, though each is several bytes.
 */
export const displayWidth = (text: string): number => {
  let width = 0;
  for (const { segment } of graphemes.segment(stripVTControlCharacters(text))) {
    width += segmentWidth(segment);
  }
  return width;
};

/**
 * `text` cut to `width` display columns, with `…` for the rest, never
 * inside a character: a cut line loses its colors.
 */
export const truncateLine = (text: string, width: number): string => {
  const plain = stripVTControlCharacters(text);
  if (displayWidth(plain) <= width) return text;
  let cut = "";
  let used = 0;
  for (const { segment } of graphemes.segment(plain)) {
    used += segmentWidth(segment);
    if (used > width - 1) break;
    cut += segment;
  }
  return `${cut.trimEnd()}…`;
};

/** The room a command's continuation, ` \`, takes at the end of a line. */
const CONTINUATION_WIDTH = 2;

// oxlint-disable-next-line no-control-regex -- a color code starts with ESC.
const COLOR_CODE = /\u001B\[(\d+)(?:;\d+)*m/gu;

/** The code that ends a color or style, by the code that starts it. */
const closingCode = (code: number): number | undefined => {
  if ((code >= 30 && code <= 38) || (code >= 90 && code <= 97)) return 39;
  if ((code >= 40 && code <= 48) || (code >= 100 && code <= 107)) return 49;
  return { 1: 22, 2: 22, 3: 23, 4: 24, 7: 27, 8: 28, 9: 29 }[code];
};

/**
 * `lines` with each color that runs past a line's end closed there and
 * reopened on the next, as clack's gutter, colored between them, ends it.
 */
const carryColors = (lines: readonly string[]): string[] => {
  const open = new Map<number, string>();
  return lines.map((line) => {
    const reopened = [...open.values()].join("");
    for (const match of line.matchAll(COLOR_CODE)) {
      const code = Number(match[1]);
      const closing = closingCode(code);
      if (code === 0) open.clear();
      else if (closing === undefined) open.delete(code);
      else open.set(closing, match[0]);
    }
    const closed = [...open.keys()]
      .reverse()
      .map((code) => `\u001B[${code}m`)
      .join("");
    return `${reopened}${line}${closed}`;
  });
};

/** A line's words, with a color code on its own joined to the next word. */
const wordsOf = (line: string, pattern: RegExp): string[] => {
  const words: string[] = [];
  let colors = "";
  for (const word of line.match(pattern) ?? []) {
    if (displayWidth(word) === 0) colors += word;
    else {
      words.push(`${colors}${word}`);
      colors = "";
    }
  }
  if (colors && words.length > 0) words[words.length - 1] += colors;
  return words;
};

const indentOf = (line: string): string =>
  /^\s*/u.exec(stripVTControlCharacters(line))?.[0] ?? "";

/** Prose's lines, broken at spaces, each with the line's indentation. */
const wrapProse = (line: string, width: number): string[] => {
  const indent = indentOf(line);
  const lines: string[] = [];
  let current = "";
  for (const word of wordsOf(line, /\S+/gu)) {
    if (current && displayWidth(`${indent}${current} ${word}`) > width) {
      lines.push(`${indent}${current}`);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  return [...lines, `${indent}${current}`];
};

/**
 * A command's lines, broken at spaces with ` \`, which counts toward the
 * width, so it still pastes as one command. A placeholder such as
 * `<env file>` stays whole. Each new line is indented two more spaces, but
 * for a line that continues a command already.
 */
const wrapCommand = (
  line: string,
  width: number,
  continued: boolean,
): string[] => {
  const indent = indentOf(line);
  const nextIndent = continued ? indent : `${indent}  `;
  const words = wordsOf(line, /(?:<[^<>]*>|\S)+/gu);
  // A line that a command continues past keeps its ` \` at its end.
  const ending =
    stripVTControlCharacters(words.at(-1) ?? "") === "\\"
      ? words.pop()
      : undefined;
  const lines: string[] = [];
  let current = "";
  words.forEach((word, index) => {
    const reserved =
      index === words.length - 1 && ending === undefined
        ? 0
        : CONTINUATION_WIDTH;
    const candidate = current ? `${current} ${word}` : `${indent}${word}`;
    if (current && displayWidth(candidate) + reserved > width) {
      lines.push(`${current} \\`);
      current = `${nextIndent}${word}`;
    } else {
      current = candidate;
    }
  });
  return [...lines, ending === undefined ? current : `${current} ${ending}`];
};

/**
 * A command to print, broken at spaces with ` \` once a line would pass
 * `width` with it, each new line indented two spaces, so a terminal never
 * wraps it mid-word and it still pastes as one command.
 */
export const formatCommand = (
  command: string,
  width: number = MESSAGE_WIDTH,
): string =>
  displayWidth(command) <= width
    ? command
    : carryColors(wrapCommand(command, width, false)).join("\n");

/** A line that is a command to copy, which breaks with ` \`, not as prose. */
const COMMAND_LINE =
  /^\s*(?:\$ )?(?:npx|pnpx|bunx|pnpm|npm|yarn|bun|hot-updater)\s/u;

/**
 * The one rule for what the CLI prints for people: `text` with each line at
 * most `width` display columns. Prose breaks at spaces, a command with ` \`,
 * and a word longer than a line, such as a URL or a path, gets a line of its
 * own, which is the one line that may be wider. A line that fits stays as it
 * is, so fitting twice changes nothing. `p` applies it to all it prints;
 * text printed another way, such as to stderr under `--json`, calls it.
 */
export const fitText = (
  text: string,
  width: number = MESSAGE_WIDTH,
): string => {
  const lines: string[] = [];
  let continued = false;
  for (const line of text.split("\n")) {
    const plain = stripVTControlCharacters(line);
    const command: boolean = continued || COMMAND_LINE.test(plain);
    if (displayWidth(line) <= width) lines.push(line);
    else if (command) lines.push(...wrapCommand(line, width, continued));
    else lines.push(...wrapProse(line, width));
    continued = command && plain.endsWith(" \\");
  }
  return (text.includes("\u001B[") ? carryColors(lines) : lines).join("\n");
};

/**
 * A message of `lines`, each fitted as `fitText` does, so a name, a path, or
 * a list it embeds never widens a line.
 */
export const fitMessage = (lines: readonly string[]): string =>
  fitText(lines.join("\n"));

/** The most a provider's message takes: two lines of a message. */
const PROVIDER_MESSAGE_WIDTH = MESSAGE_WIDTH * 2;

/** What a response with no message it says shows of itself. */
const UNREAD_BODY_WIDTH = 40;

/** Where an error body says what went wrong, most specific first. */
const MESSAGE_KEYS = [
  "errors",
  "error_description",
  "message",
  "error",
  "detail",
  "title",
  "msg",
];

const messagesIn = (body: unknown): string[] => {
  if (typeof body === "string") return body.trim() ? [body.trim()] : [];
  if (Array.isArray(body)) return body.flatMap(messagesIn);
  if (!body || typeof body !== "object") return [];
  for (const key of MESSAGE_KEYS) {
    const messages = messagesIn((body as Record<string, unknown>)[key]);
    if (messages.length > 0) return messages;
  }
  return [];
};

/** Where the JSON value that opens at `start` closes, or -1. */
const closingIndex = (text: string, start: number): number => {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const parseBody = (text: string): object | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return value &&
      typeof value === "object" &&
      (!Array.isArray(value) ||
        value.every((entry) => entry && typeof entry === "object"))
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * `text` with each JSON body in it, such as the response an SDK's error
 * embeds, replaced with the message the body says, as people read an error:
 * Cloudflare's `errors[].message`, or a `message` or an `error`. A body that
 * says none is cut. Printed errors go through it; `--json` keeps the body.
 * A registered value is masked before anything is cut, as a cut one no longer
 * matches, and again after, as a body's string may have escaped it.
 */
export const withProviderMessages = (message: string): string => {
  const text = maskSecretValues(message);
  let result = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const end = char === "{" || char === "[" ? closingIndex(text, index) : -1;
    const body = end === -1 ? undefined : parseBody(text.slice(index, end + 1));
    if (body === undefined) {
      result += char;
      index += 1;
      continue;
    }
    const messages = [...new Set(messagesIn(body))];
    result += messages.length
      ? truncateLine(messages.join("; "), PROVIDER_MESSAGE_WIDTH)
      : truncateLine(text.slice(index, end + 1), UNREAD_BODY_WIDTH);
    index = end + 1;
  }
  return maskSecretValues(result);
};
