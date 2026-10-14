/** Elements whose text can span several lines in a pretty-printed plist. */
const TEXT_ELEMENT = /<(key|string|data|date|integer|real)>/;
const closingTag = (name: string) => `</${name}>`;

/**
 * Lays out `plist.build` output the way Xcode writes an Info.plist, so that
 * writing one key does not shift every other line of the file.
 *
 * `plist.build` indents everything under `<plist>` one level, while Xcode
 * puts the root `<dict>` at column 0. When the previous file had its root at
 * column 0 (or there is no previous file), every element line under `<plist>`
 * loses one leading tab. A file whose root is already indented under
 * `<plist>` (the layout `plist.build` itself writes) is left indented. Text of a multi-line value is left as it is: a text line
 * never starts with a raw `<`, and lines between an opening and a closing text
 * tag are skipped. The file keeps the trailing newline it had.
 */
export function formatPlistLikeXcode(built: string, previous?: string): string {
  const lines = built.split("\n");
  const formatted: string[] = [];
  let insidePlist = false;
  let openText: string | null = null;
  const dedent = previous === undefined || rootIsAtColumnZero(previous);

  for (const line of lines) {
    if (openText !== null) {
      formatted.push(line);
      if (line.includes(closingTag(openText))) {
        openText = null;
      }
      continue;
    }

    if (line.startsWith("</plist>")) {
      insidePlist = false;
    }
    formatted.push(
      dedent && insidePlist && /^\t+</.test(line) ? line.slice(1) : line,
    );
    if (/^<plist\b/.test(line)) {
      insidePlist = true;
    }

    const opened = TEXT_ELEMENT.exec(line);
    if (opened) {
      const rest = line.slice(opened.index + opened[0].length);
      if (!rest.includes(closingTag(opened[1]!))) {
        openText = opened[1]!;
      }
    }
  }

  let result = formatted.join("\n");
  if (previous?.endsWith("\n") && !result.endsWith("\n")) {
    result += "\n";
  }
  return result;
}

/**
 * Whether the root element under `<plist>` in `xml` starts at column 0.
 * Blank lines and XML comments before the root are skipped.
 */
function rootIsAtColumnZero(xml: string): boolean {
  const open = /<plist\b[^>]*>/.exec(xml);
  if (!open) {
    return true;
  }
  const rest = xml
    .slice(open.index + open[0].length)
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
  for (const line of rest.split("\n").slice(1)) {
    const indent = /^[^\S\n]*(?=<)/.exec(line);
    if (indent) {
      return indent[0] === "";
    }
  }
  return true;
}
