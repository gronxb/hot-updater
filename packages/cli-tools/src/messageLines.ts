import { stripVTControlCharacters } from "node:util";

/**
 * The widest line of a message the CLI prints: clack puts it after its
 * 3-column gutter (`│  `), and the whole line stays within 76 columns.
 */
export const MESSAGE_WIDTH = 73;

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

/**
 * A message of `lines`, each at most `MESSAGE_WIDTH` columns, broken at
 * spaces, so a name, a path, or a list it embeds never widens a line. A
 * word longer than a line, such as a URL or a path, gets a line of its
 * own. Lines that fit, such as an indented command, stay as they are.
 */
export const fitMessage = (lines: readonly string[]): string =>
  lines
    .flatMap((line) => {
      if (displayWidth(line) <= MESSAGE_WIDTH) return [line];
      const fitted: string[] = [];
      let current = "";
      for (const word of line.split(" ").filter(Boolean)) {
        if (
          current &&
          displayWidth(current) + 1 + displayWidth(word) > MESSAGE_WIDTH
        ) {
          fitted.push(current);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      return [...fitted, current];
    })
    .join("\n");
