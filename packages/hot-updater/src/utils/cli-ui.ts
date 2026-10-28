import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { colors, getCwd } from "@hot-updater/cli-tools";

type StringValue = string | number | boolean | null | undefined;

/** One `label  value` row. */
export type Row = readonly [label: string, value: StringValue];

/** A row, or a falsy entry that is left out, as `cond && [label, value]` gives. */
export type MaybeRow = Row | false | null | undefined | "" | 0;

/** The widest a path is shown, so a row fits an 80-column terminal. */
const PATH_WIDTH = 48;

/**
 * The widest an artifact's path is shown, after a 15-column label: a path
 * to install or copy is shortened only when its row would wrap.
 */
export const ARTIFACT_PATH_WIDTH = 62;

/** The widest a line is, after clack's 3-column gutter on 80 columns. */
const LINE_WIDTH = 77;

/** The widest a command line is shown, after clack's 3-column gutter. */
const COMMAND_WIDTH = 74;

interface TableColumn<TKey extends string> {
  key: TKey;
  label?: string;
  format?: (value: string) => string;
}

const stringify = (value: StringValue): string =>
  value === null || value === undefined ? "" : String(value);

const colorIfPresent = (
  value: StringValue,
  color: (input: string) => string,
): string => {
  const text = stringify(value);
  return text ? color(text) : colors.dim("-");
};

export const ui = {
  title: (text: string): string => colors.bold(colors.cyan(text)),
  code: (text: StringValue): string => colors.dim(stringify(text)),
  command: (text: StringValue): string => colors.green(stringify(text)),
  muted: (text: StringValue): string => colors.dim(stringify(text)),
  id: (value: StringValue): string => colorIfPresent(value, colors.yellow),
  path: (value: StringValue): string => colorIfPresent(value, colors.dim),
  channel: (value: StringValue): string => colorIfPresent(value, colors.blue),
  platform: (value: StringValue): string => colorIfPresent(value, colors.cyan),
  version: (value: StringValue): string =>
    colorIfPresent(value, colors.magenta),
  success: (text: StringValue): string => colors.green(stringify(text)),
  danger: (text: StringValue): string => colors.red(stringify(text)),
  warning: (text: StringValue): string => colors.yellow(stringify(text)),
  status: (enabled: boolean): string =>
    enabled ? colors.green("enabled") : colors.red("disabled"),
  bool: (value: boolean): string =>
    value ? colors.green("yes") : colors.dim("no"),
  /** A `label  value` row, which `ui.block` lines up with the others. */
  kv: (label: string, value: StringValue): Row => [label, value],
  line: (parts: string[]): string => parts.filter(Boolean).join(" "),
  /**
   * A heading and its lines, for `p.log.step`, `p.log.success`, or
   * `p.log.warn`, whose symbol marks the heading. Its `ui.kv` rows have
   * their labels padded to the widest label plus two spaces, without
   * colons; a falsy entry, as `cond && ui.kv(...)` gives, is left out.
   */
  block: (
    heading: string,
    lines: readonly (string | MaybeRow)[] = [],
  ): string => {
    const entries = lines.filter(
      (line): line is string | Row => typeof line === "string" || Boolean(line),
    );
    const width =
      Math.max(
        0,
        ...entries.map((entry) =>
          typeof entry === "string" ? 0 : entry[0].length,
        ),
      ) + 2;
    return [
      heading,
      ...entries.map((entry) =>
        typeof entry === "string" ? entry : renderRow(entry, width),
      ),
    ]
      .filter(Boolean)
      .join("\n");
  },
  /**
   * A command to copy, highlighted, broken at spaces with ` \` when it is
   * longer than `width`, each continuation indented two spaces, so the
   * terminal never wraps it mid-word. A placeholder such as `<env file>`
   * stays whole.
   */
  commandLines: (command: string, width: number = COMMAND_WIDTH): string => {
    const lines: string[] = [];
    let line = "";
    for (const word of command.match(/(?:<[^<>]*>|\S)+/gu) ?? []) {
      const next = line ? `${line} ${word}` : word;
      if (line && next.length > width - 2) {
        lines.push(`${line} \\`);
        line = `  ${word}`;
      } else {
        line = next;
      }
    }
    lines.push(line);
    return lines.map((text) => colors.green(text)).join("\n");
  },
  /**
   * `lead` and the command it names, on one line when they fit, else the
   * command on the lines after it: `Run in a terminal: npx hot-updater …`.
   */
  withCommand: (lead: string, command: string): string =>
    lead.length + 1 + command.length <= LINE_WIDTH
      ? `${lead} ${colors.green(command)}`
      : `${lead}\n${ui.commandLines(command)}`,
  /**
   * Text written once for both `--json` and people, such as a doctor
   * issue's resolution, laid out for a terminal: one sentence per line,
   * wrapped at spaces, with each `command` highlighted, without its
   * backticks, and on lines of its own when it is too long to share one.
   */
  prose: (text: string, width: number = LINE_WIDTH): string =>
    text
      .split(/(?<=[.!?])\s+(?=[A-Z`])/u)
      .flatMap((sentence) => wrapWords(sentence, width))
      .join("\n"),
  /**
   * A path as a person reads it: relative to the project when inside it,
   * with `~` for the home directory otherwise, and a long middle shortened
   * to `…` so it never wraps.
   */
  fitPath: (file: string, width: number = PATH_WIDTH): string =>
    shortenPath(displayPath(file), width),
  table: <TKey extends string>(
    columns: readonly TableColumn<TKey>[],
    rows: readonly Record<TKey, StringValue>[],
  ): string => {
    const widths = columns.map((column) => {
      const label = column.label ?? column.key;
      return Math.max(
        label.length,
        ...rows.map((row) => stringify(row[column.key]).length),
      );
    });

    const border = (left: string, join: string, right: string): string =>
      `${left}${widths
        .map((width) => "─".repeat(width + 2))
        .join(join)}${right}`;

    const renderRow = (
      getValue: (column: TableColumn<TKey>) => string,
      format: boolean,
    ): string =>
      `│ ${columns
        .map((column, index) => {
          const width = widths[index] ?? 0;
          const value = getValue(column).padEnd(width);
          return format && column.format ? column.format(value) : value;
        })
        .join(" │ ")} │`;

    const header = renderRow((column) => column.label ?? column.key, false);
    const body = rows.map((row) =>
      renderRow((column) => stringify(row[column.key]), true),
    );

    return [
      border("┌", "┬", "┐"),
      colors.bold(header),
      border("├", "┼", "┤"),
      ...body,
      border("└", "┴", "┘"),
    ].join("\n");
  },
};

const displayPath = (file: string): string => {
  if (!path.isAbsolute(file)) return file;
  const relative = path.relative(getCwd(), file);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  const home = os.homedir();
  return file === home || file.startsWith(`${home}${path.sep}`)
    ? `~${file.slice(home.length)}`
    : file;
};

/**
 * Keeps the leading directories that fit and the file name, with `…` for
 * the directories between: `~/.hot-updater/secrets/…/asc-api-key.json`.
 */
const shortenPath = (file: string, width: number): string => {
  if (file.length <= width) return file;
  const segments = file.split("/");
  const last = segments.pop() ?? "";
  const head: string[] = [];
  for (const segment of segments) {
    if ([...head, segment, "…", last].join("/").length > width) break;
    head.push(segment);
  }
  return head.length === segments.length
    ? file
    : [...head, "…", last].join("/");
};

/**
 * A sentence's lines, at most `width` wide, broken at spaces; a `command`
 * in backticks stays whole, highlighted, and goes on lines of its own when
 * it would not fit on one with the words around it.
 */
const wrapWords = (sentence: string, width: number): string[] => {
  const lines: string[] = [];
  let line = "";
  let length = 0;
  const flush = () => {
    if (line) lines.push(line);
    line = "";
    length = 0;
  };
  for (const token of sentence.match(/`[^`]*`\S*|\S+/gu) ?? []) {
    const command = /^`([^`]*)`(\S*)$/u.exec(token);
    const visible = command ? `${command[1]}${command[2]}` : token;
    const text = command
      ? `${colors.green(command[1] ?? "")}${command[2]}`
      : token;
    if (command && visible.length > width) {
      flush();
      // Punctuation after it, such as a sentence's period, ends its line.
      lines.push(`${ui.commandLines(command[1] ?? "")}${command[2]}`);
      continue;
    }
    if (length > 0 && length + 1 + visible.length > width) flush();
    line = length > 0 ? `${line} ${text}` : text;
    length += (length > 0 ? 1 : 0) + visible.length;
  }
  flush();
  return lines;
};

/**
 * One row: a value too long for it, such as a URL, goes under its label,
 * and the lines of a value of several, such as a list, line up.
 */
const renderRow = ([label, value]: Row, width: number): string => {
  const [first = "", ...more] = (stringify(value) || colors.dim("-")).split(
    "\n",
  );
  if (
    more.length === 0 &&
    width + stripVTControlCharacters(first).length > LINE_WIDTH
  ) {
    return `${colors.dim(label)}\n${first}`;
  }
  return [
    `${colors.dim(label.padEnd(width))}${first}`,
    ...more.map((line) => `${" ".repeat(width)}${line}`),
  ].join("\n");
};
