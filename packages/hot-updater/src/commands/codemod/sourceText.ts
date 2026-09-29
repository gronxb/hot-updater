/** A replacement of `source.slice(start, end)` with `text`. */
export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A source range, as parser nodes carry it. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** The line break a file already uses. */
export const lineBreakOf = (source: string): string =>
  source.includes("\r\n") ? "\r\n" : "\n";

/** Applies edits that do not overlap; insertions at one offset keep their order. */
export const applyTextEdits = (
  source: string,
  edits: readonly TextEdit[],
): string => {
  const ordered = edits
    .map((edit, order) => ({ edit, order }))
    .sort(
      (left, right) =>
        left.edit.start - right.edit.start ||
        left.edit.end - right.edit.end ||
        left.order - right.order,
    );
  let output = "";
  let cursor = 0;
  for (const { edit } of ordered) {
    if (edit.start < cursor) {
      throw new Error("Codemod edits overlap.");
    }
    output += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return output + source.slice(cursor);
};

/** The offset where the line holding `offset` starts. */
export const lineStart = (source: string, offset: number): number =>
  source.lastIndexOf("\n", offset - 1) + 1;

/** The offset of the line break ending the line holding `offset`. */
export const lineEnd = (source: string, offset: number): number => {
  const newline = source.indexOf("\n", offset);
  if (newline === -1) return source.length;
  return source[newline - 1] === "\r" ? newline - 1 : newline;
};

/** The offset just past the line break ending the line holding `offset`. */
export const nextLineStart = (source: string, offset: number): number => {
  const newline = source.indexOf("\n", offset);
  return newline === -1 ? source.length : newline + 1;
};

/** The whitespace that indents the line holding `offset`. */
export const indentOf = (source: string, offset: number): string =>
  /^[ \t]*/.exec(source.slice(lineStart(source, offset)))?.[0] ?? "";

/** Whether only whitespace precedes `offset` on its line. */
export const startsLine = (source: string, offset: number): boolean =>
  /^[ \t]*$/.test(source.slice(lineStart(source, offset), offset));

/** The first offset at or after `offset` outside whitespace and comments. */
export const skipTrivia = (source: string, offset: number): number => {
  let index = offset;
  while (index < source.length) {
    if (/\s/.test(source[index]!)) {
      index += 1;
    } else if (source.startsWith("//", index)) {
      index = lineEnd(source, index);
    } else if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? source.length : close + 2;
    } else {
      break;
    }
  }
  return index;
};

/** Whether only whitespace and comments follow `offset` on its line. */
export const restOfLineIsTrivia = (source: string, offset: number): boolean => {
  const end = lineEnd(source, offset);
  let index = offset;
  while (index < end) {
    if (source[index] === " " || source[index] === "\t") {
      index += 1;
    } else if (source.startsWith("//", index)) {
      return true;
    } else if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      if (close === -1 || close + 2 > end) return false;
      index = close + 2;
    } else {
      return false;
    }
  }
  return true;
};

/** The 1-based line and column of `offset`. */
export const locate = (
  source: string,
  offset: number,
): { readonly line: number; readonly column: number } => ({
  line: source.slice(0, offset).split("\n").length,
  column: offset - lineStart(source, offset) + 1,
});

/**
 * Edits that add `text` after `item` in a comma-separated list: on a line of
 * its own when `item` has one, otherwise inline. A trailing comma is kept.
 */
export const insertListItemAfter = (
  source: string,
  item: Span,
  text: string,
): TextEdit[] => {
  const next = skipTrivia(source, item.end);
  const hasComma = source[next] === ",";
  const afterItem = hasComma ? next + 1 : item.end;
  if (
    !startsLine(source, item.start) ||
    !restOfLineIsTrivia(source, afterItem)
  ) {
    return [{ start: item.end, end: item.end, text: `, ${text}` }];
  }
  const indent = indentOf(source, item.start);
  const end = lineEnd(source, afterItem);
  const line = `${lineBreakOf(source)}${indent}${text}`;
  return hasComma
    ? [{ start: end, end, text: `${line},` }]
    : [
        { start: item.end, end: item.end, text: "," },
        { start: end, end, text: line },
      ];
};

/**
 * Edits that remove `item` from a comma-separated list: its whole line when
 * it has one, otherwise the item and the comma that joins it.
 */
export const removeListItem = (
  source: string,
  items: readonly Span[],
  item: Span,
): TextEdit[] => {
  const next = skipTrivia(source, item.end);
  const afterItem = source[next] === "," ? next + 1 : item.end;
  if (startsLine(source, item.start) && restOfLineIsTrivia(source, afterItem)) {
    return [
      {
        start: lineStart(source, item.start),
        end: nextLineStart(source, afterItem),
        text: "",
      },
    ];
  }
  const index = items.indexOf(item);
  const following = items[index + 1];
  if (following) {
    return [{ start: item.start, end: following.start, text: "" }];
  }
  const previous = items[index - 1];
  return previous
    ? [{ start: previous.end, end: item.end, text: "" }]
    : [{ start: item.start, end: afterItem, text: "" }];
};
