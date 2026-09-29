type DiffLine = {
  readonly kind: " " | "-" | "+";
  readonly text: string;
};

const CONTEXT_LINES = 3;

const splitLines = (text: string): string[] => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** The shortest line edit script from `before` to `after` (Myers' algorithm). */
const diffLines = (
  before: readonly string[],
  after: readonly string[],
): DiffLine[] => {
  const max = before.length + after.length;
  const offset = max + 1;
  const furthest = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  search: for (let depth = 0; depth <= max; depth += 1) {
    trace.push(furthest.slice());
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const down =
        diagonal === -depth ||
        (diagonal !== depth &&
          furthest[offset + diagonal - 1]! < furthest[offset + diagonal + 1]!);
      let x = down
        ? furthest[offset + diagonal + 1]!
        : furthest[offset + diagonal - 1]! + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      furthest[offset + diagonal] = x;
      if (x >= before.length && y >= after.length) break search;
    }
  }

  const lines: DiffLine[] = [];
  let x = before.length;
  let y = after.length;
  for (let depth = trace.length - 1; depth >= 0; depth -= 1) {
    const previous = trace[depth]!;
    const diagonal = x - y;
    const down =
      diagonal === -depth ||
      (diagonal !== depth &&
        previous[offset + diagonal - 1]! < previous[offset + diagonal + 1]!);
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
    const previousX = previous[offset + previousDiagonal]!;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      lines.push({ kind: " ", text: before[x]! });
    }
    if (depth > 0) {
      if (x === previousX) {
        y -= 1;
        lines.push({ kind: "+", text: after[y]! });
      } else {
        x -= 1;
        lines.push({ kind: "-", text: before[x]! });
      }
    }
  }
  return lines.reverse();
};

const range = (start: number, count: number) =>
  `${count === 0 ? start - 1 : start},${count}`;

/** A unified diff of one file, with three lines of context around each change. */
export const formatUnifiedDiff = (
  filePath: string,
  before: string,
  after: string,
): string => {
  const lines = diffLines(splitLines(before), splitLines(after));
  const beforeLine: number[] = [];
  const afterLine: number[] = [];
  let beforeNumber = 1;
  let afterNumber = 1;
  for (const line of lines) {
    beforeLine.push(beforeNumber);
    afterLine.push(afterNumber);
    if (line.kind !== "+") beforeNumber += 1;
    if (line.kind !== "-") afterNumber += 1;
  }

  const changes = lines.flatMap((line, index) =>
    line.kind === " " ? [] : [index],
  );
  const output = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (let index = 0; index < changes.length; index += 1) {
    const first = changes[index]!;
    while (
      index + 1 < changes.length &&
      changes[index + 1]! - changes[index]! - 1 <= 2 * CONTEXT_LINES
    ) {
      index += 1;
    }
    const start = Math.max(0, first - CONTEXT_LINES);
    const end = Math.min(lines.length, changes[index]! + CONTEXT_LINES + 1);
    const hunk = lines.slice(start, end);
    const beforeCount = hunk.filter((line) => line.kind !== "+").length;
    const afterCount = hunk.filter((line) => line.kind !== "-").length;
    output.push(
      `@@ -${range(beforeLine[start]!, beforeCount)} +${range(afterLine[start]!, afterCount)} @@`,
      ...hunk.map((line) => `${line.kind}${line.text}`),
    );
  }
  return output.join("\n");
};
