import { describe, expect, it } from "vitest";

import {
  type FoldedEntry,
  foldedPage,
  type ReadRows,
  readFold,
} from "./foldedPage";

type Row = { readonly id: string };

const id = (n: number) => `row-${String(n).padStart(4, "0")}`;

/**
 * An index of rows 1..count, newest (highest) first, where `ordinary` says
 * which are ordinary. It counts the rows each read returns.
 */
const index = (count: number, ordinary: (n: number) => boolean) => {
  const rows: Row[] = Array.from({ length: count }, (_, i) => ({
    id: id(i + 1),
  }));
  const reads: number[] = [];
  const read: ReadRows<Row> = async ({ order, after, limit }) => {
    const sorted = order === "desc" ? [...rows].reverse() : [...rows];
    const start =
      after === undefined
        ? 0
        : sorted.findIndex((row) =>
            order === "desc" ? row.id < after : row.id > after,
          );
    const page = start < 0 ? [] : sorted.slice(start, start + limit);
    reads.push(page.length);
    return page;
  };
  const classify = async (
    chunk: readonly Row[],
    _context?: { readonly budget: { left: number } },
  ) =>
    new Set(
      chunk
        .filter(({ id: rowId }) => ordinary(Number(rowId.slice(4))))
        .map(({ id: rowId }) => rowId),
    );
  return { read, classify, reads };
};

/** A page's entries as text: `n` for an ordinary row, `[count]` for a fold. */
const shape = (entries: readonly FoldedEntry<Row>[]) =>
  entries.map((entry) =>
    entry.kind === "row"
      ? Number(entry.row.id.slice(4))
      : `[${entry.count}${entry.more ? "+" : ""}]`,
  );

describe("foldedPage", () => {
  it("keeps the list's order, each run of folded rows one fold where it sits", async () => {
    // 10 9 8 7 6 5 4 3 2 1: 10, 7 and 3 ordinary.
    const list = index(10, (n) => n === 10 || n === 7 || n === 3);
    const page = await foldedPage({ ...list, size: 20 });

    expect(shape(page.entries)).toEqual([10, "[2]", 7, "[3]", 3, "[2]"]);
    expect(page.entries[1]).toEqual({
      kind: "fold",
      count: 2,
      more: false,
      from: id(10),
      to: id(8),
    });
    expect(page.next).toBeUndefined();
    expect(page.previous).toBeUndefined();
  });

  it("counts only ordinary rows, and ends a page with the run under its last one, so the next starts with an ordinary row", async () => {
    // Ordinary every 4th row: 20 16 12 8 4.
    const list = index(20, (n) => n % 4 === 0);
    const first = await foldedPage({ ...list, size: 2 });

    // 20, [19 18 17], 16, then the run under 16 down to 13.
    expect(shape(first.entries)).toEqual([20, "[3]", 16, "[3]"]);
    expect(first.previous).toBeUndefined();

    const second = await foldedPage({ ...list, size: 2, before: first.next });
    expect(shape(second.entries)).toEqual([12, "[3]", 8, "[3]"]);
    expect(second.entries[0]).toMatchObject({ row: { id: id(12) } });
    // Back up: the same page, its run above 12 is the end of the first.
    const back = await foldedPage({ ...list, size: 2, ...second.previous });
    expect(back).toEqual(first);
  });

  it("shows a pinned row where it sits without counting it, so its run splits around it and the page keeps its rows", async () => {
    // Ordinary every 4th row: 20 16 12 8 4; 14 is in the run under 16.
    const list = index(20, (n) => n % 4 === 0);
    const first = await foldedPage({ ...list, size: 2, pinned: id(14) });

    expect(shape(first.entries)).toEqual([20, "[3]", 16, "[1]", 14, "[1]"]);
    // The page below is the same page with or without the pin.
    const second = await foldedPage({ ...list, size: 2, before: first.next });
    expect(shape(second.entries)).toEqual([12, "[3]", 8, "[3]"]);
    expect(first.next).toBe((await foldedPage({ ...list, size: 2 })).next);
    // Back up to it, pinned: the pinned row is in the run that ends it.
    const back = await foldedPage({
      ...list,
      size: 2,
      ...second.previous,
      pinned: id(14),
    });
    expect(back.entries).toEqual(first.entries);
  });

  it("ends a page out of budget in a fold that goes on, which the next page continues", async () => {
    // 300 rows, ordinary: 300 and 1 only.
    const list = index(300, (n) => n === 300 || n === 1);
    const first = await foldedPage({ ...list });

    expect(shape(first.entries)).toEqual([300, "[100+]"]);
    expect(list.reads.reduce((sum, rows) => sum + rows, 0)).toBe(200);

    const second = await foldedPage({ ...list, before: first.next });
    expect(shape(second.entries)).toEqual(["[99]", 1]);
    expect(second.entries[0]).toMatchObject({ from: id(101), to: id(2) });
  });

  it("goes Next and back to the same page at the read budget, its leading and trailing folds kept", async () => {
    // 1,000 rows, only 950 ordinary: the first page runs out of budget.
    const list = index(1_000, (n) => n === 950);
    const first = await foldedPage({ ...list });
    expect(shape(first.entries)).toEqual(["[50]", 950, "[100+]"]);

    const second = await foldedPage({ ...list, before: first.next });
    const third = await foldedPage({ ...list, before: second.next });
    const backToSecond = await foldedPage({ ...list, ...third.previous });
    const backToFirst = await foldedPage({ ...list, ...backToSecond.previous });

    expect(backToSecond).toEqual(second);
    expect(backToFirst).toEqual(first);
    expect(backToFirst.previous).toBeUndefined();
  });

  it("reads at most 200 rows a page in either direction, its classification's reads included", async () => {
    const list = index(1_000, (n) => n === 950);
    let spent = 0;
    const read: typeof list.read = async (input) => {
      const rows = await list.read(input);
      spent += rows.length;
      return rows;
    };
    // A rule that reads 10 rows of its own per chunk, from its budget.
    const classify: typeof list.classify = async (chunk, context) => {
      const budget = context?.budget ?? { left: 10 };
      const own = await read({
        order: "desc",
        limit: Math.min(10, budget.left),
      });
      budget.left -= own.length;
      return list.classify(chunk, { budget });
    };
    for (const input of [
      {},
      { before: "s.row-0700" },
      { after: id(600) },
      { after: id(999) },
    ]) {
      spent = 0;
      await foldedPage({ read, classify, ...input });
      expect(spent, JSON.stringify(input)).toBeLessThanOrEqual(200);
    }
  });

  it("drops no row reading up from a link that remembers no page", async () => {
    const list = index(1_000, (n) => n === 950);
    const seen: string[] = [];
    const rowsOf = async (entries: readonly FoldedEntry<Row>[]) => {
      for (const entry of entries) {
        if (entry.kind === "row") seen.push(entry.row.id);
        else {
          for (let after: string | undefined; ; ) {
            const chunk = await readFold({
              read: list.read,
              ...(entry.from === undefined ? {} : { from: entry.from }),
              to: entry.to,
              ...(after === undefined ? {} : { after }),
            });
            seen.push(...chunk.rows.map(({ id: rowId }) => rowId));
            if (chunk.next === undefined) break;
            after = chunk.next;
          }
        }
      }
    };
    // Up from 800, as a bare cursor's Previous does, to the top.
    let page = await foldedPage({ ...list, after: id(800) });
    await rowsOf(page.entries);
    while (page.previous !== undefined) {
      page = await foldedPage({ ...list, ...page.previous });
      await rowsOf(page.entries);
    }

    expect(seen.sort()).toEqual(
      Array.from({ length: 200 }, (_, i) => id(801 + i)),
    );
  });

  it("shows a page of folded rows alone as one fold with its count", async () => {
    const list = index(30, () => false);
    const page = await foldedPage({ ...list });

    expect(shape(page.entries)).toEqual(["[30]"]);
    expect(page.entries[0]).toEqual({
      kind: "fold",
      count: 30,
      more: false,
      to: id(1),
    });
  });

  it("caps a fold's count at 100", async () => {
    const list = index(150, (n) => n === 150 || n === 1);
    const page = await foldedPage({ ...list });

    expect(shape(page.entries)).toEqual([150, "[100+]", 1]);
  });

  it("reads one chunk at a time, and stops once the next page's first ordinary row is in", async () => {
    const list = index(1_000, () => true);
    await foldedPage({ ...list, size: 20 });

    expect(list.reads).toEqual([50]);
  });

  it("gives the same page for the same cursor, whatever happened between", async () => {
    const list = index(40, (n) => n % 3 === 0);
    const once = await foldedPage({ ...list, size: 5 });
    await readFold({ read: list.read, to: id(35), from: id(36) });
    const again = await foldedPage({ ...list, size: 5 });

    expect(again).toEqual(once);
  });
});

describe("readFold", () => {
  it("reads only the fold's rows, newest first, a chunk at a time", async () => {
    const list = index(20, (n) => n % 4 === 0);
    // The fold under 16 down to 13.
    const first = await readFold({
      read: list.read,
      from: id(16),
      to: id(13),
      limit: 2,
    });
    expect(first.rows.map(({ id: rowId }) => rowId)).toEqual([id(15), id(14)]);
    expect(first.next).toBe(id(14));

    const rest = await readFold({
      read: list.read,
      from: id(16),
      to: id(13),
      after: first.next,
      limit: 2,
    });
    expect(rest.rows.map(({ id: rowId }) => rowId)).toEqual([id(13)]);
    expect(rest.next).toBeUndefined();
  });

  it("reads a fold at the top of the list from the top", async () => {
    const list = index(5, (n) => n === 2);
    const fold = await readFold({ read: list.read, to: id(3) });

    expect(fold.rows.map(({ id: rowId }) => rowId)).toEqual([
      id(5),
      id(4),
      id(3),
    ]);
    expect(fold.next).toBeUndefined();
  });
});
