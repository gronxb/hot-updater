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
  const classify = async (chunk: readonly Row[]) =>
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
    expect(first.next).toBe(id(13));

    const second = await foldedPage({ ...list, size: 2, before: first.next });
    expect(shape(second.entries)).toEqual([12, "[3]", 8, "[3]"]);
    expect(second.previous).toBe(id(12));
    // Back up: the same page, its run above 12 is the end of the first.
    const back = await foldedPage({
      ...list,
      size: 2,
      after: second.previous,
    });
    expect(back.entries).toEqual(first.entries.map((entry) => entry));
    expect(back.next).toBe(first.next);
  });

  it("ends a page out of budget in a fold that goes on, which the next page continues", async () => {
    // 300 rows, ordinary: 300 and 1 only.
    const list = index(300, (n) => n === 300 || n === 1);
    const first = await foldedPage({ ...list });

    expect(shape(first.entries)).toEqual([300, "[100+]"]);
    expect(list.reads.reduce((sum, rows) => sum + rows, 0)).toBe(200);
    expect(first.next).toBe(id(101));

    const second = await foldedPage({ ...list, before: first.next });
    expect(shape(second.entries)).toEqual(["[99]", 1]);
    expect(second.entries[0]).toMatchObject({ from: id(101), to: id(2) });
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
