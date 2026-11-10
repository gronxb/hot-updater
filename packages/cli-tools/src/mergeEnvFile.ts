import { parseLoadedEnv } from "./hotUpdaterEnv";

const BARE_VALUE = /^[A-Za-z0-9_./:@%+,=-]+$/u;

/**
 * `value` as an env file's value, in the first form `parseLoadedEnv` reads
 * back exactly: bare, single-quoted on one line, double-quoted with its
 * newlines as `\n`, in backticks, or single-quoted across lines. Undefined
 * for a value no form holds, such as one with every quote mark and a newline.
 */
export const formatEnvValue = (value: string): string | undefined => {
  const forms = [
    ...(BARE_VALUE.test(value) ? [value] : []),
    ...(value.includes("\n") ? [] : [`'${value}'`]),
    `"${value.replaceAll("\n", "\\n")}"`,
    `\`${value}\``,
    `'${value}'`,
  ];
  return forms.find((form) => parseLoadedEnv(`V=${form}\n`)["V"] === value);
};

interface EnvEntry {
  readonly key: string;
  /** Where the value starts in the file, after `=` and any spaces. */
  readonly start: number;
  /** Where it ends, past a closing quote, before an inline comment. */
  readonly end: number;
}

const ASSIGNMENT = /^\s*(?:export\s+)?([^\s=#]+)[ \t]*=[ \t]*/u;

/** The file's assignments in order, read as `parseLoadedEnv` reads them. */
const scanEntries = (content: string): readonly EnvEntry[] => {
  const entries: EnvEntry[] = [];
  const lineEnd = (from: number) => {
    const newline = content.indexOf("\n", from);
    return newline === -1 ? content.length : newline;
  };
  let position = 0;
  while (position < content.length) {
    const end = lineEnd(position);
    const match = ASSIGNMENT.exec(content.slice(position, end));
    if (!match) {
      position = end + 1;
      continue;
    }
    const start = position + match[0].length;
    const quote = content[start];
    const closing =
      quote === '"' || quote === "'" || quote === "`"
        ? content.indexOf(quote, start + 1)
        : -1;
    if (closing !== -1) {
      entries.push({ key: match[1]!, start, end: closing + 1 });
      position = lineEnd(closing + 1) + 1;
      continue;
    }
    const comment = content.indexOf("#", start);
    const stop = comment !== -1 && comment < end ? comment : end;
    entries.push({
      key: match[1]!,
      start,
      end: start + content.slice(start, stop).trimEnd().length,
    });
    position = end + 1;
  }
  return entries;
};

const sameEnv = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
) =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.keys(left).every(
    (key) => Object.hasOwn(right, key) && left[key] === right[key],
  );

/**
 * `content`, an env file, with `values` set, already as `formatEnvValue`
 * gives them: a variable it assigns has only that value replaced, the last
 * assignment when it repeats, which is the one that counts, and a new one
 * goes at the end. Every other byte stays: other lines, comments, an
 * `export`, an inline comment. Undefined when `parseLoadedEnv` wouldn't read
 * exactly that back, so a file this can't follow is never rewritten.
 */
export const mergeEnvContent = (
  content: string,
  values: ReadonlyMap<string, string>,
): string | undefined => {
  const entries = scanEntries(content);
  const last = new Map(entries.map((entry) => [entry.key, entry]));
  const replaced = [...values.keys()]
    .flatMap((key) => last.get(key) ?? [])
    .sort((left, right) => right.start - left.start);
  let merged = content;
  for (const entry of replaced) {
    // An empty value's inline comment needs a space from the new value.
    const gap = merged[entry.end] === "#" ? " " : "";
    merged = `${merged.slice(0, entry.start)}${values.get(entry.key)}${gap}${merged.slice(entry.end)}`;
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const added = [...values].filter(([key]) => !last.has(key));
  if (added.length > 0) {
    const gap = merged === "" || merged.endsWith("\n") ? "" : eol;
    merged += `${gap}${added.map(([key, value]) => `${key}=${value}${eol}`).join("")}`;
  }
  const expected: Record<string, string> = { ...parseLoadedEnv(content) };
  for (const [key, value] of values) {
    expected[key] = parseLoadedEnv(`V=${value}\n`)["V"] ?? "";
  }
  return sameEnv(parseLoadedEnv(merged), expected) ? merged : undefined;
};
