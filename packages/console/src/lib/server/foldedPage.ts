/*
 * A list page that counts only its ordinary rows, the ones a list leads with
 * (a reachable bundle, the newest build of a distribution path), and folds
 * every run of other rows between them into one entry: how many rows it
 * holds and where they lie, never the rows themselves. A fold's rows load
 * when someone opens it. Pages read ahead through the list's own index, up to
 * a budget of rows, and keep no state: a page's cursor says where it starts
 * and where the pages before it started, so Previous reads a page again
 * exactly as Next read it.
 */

/** How many ordinary rows one page shows. */
export const FOLDED_PAGE_SIZE = 20;

/** The most rows one page reads, the list's and any it reads to classify them. */
export const FOLDED_PAGE_READ_BUDGET = 200;

/** How many rows one read of the index takes. */
export const FOLDED_PAGE_CHUNK = 50;

/** The count a fold shows exactly; past it, "100+". */
export const FOLD_COUNT_CAP = 100;

/** How many earlier pages a cursor remembers, for Previous. */
export const FOLDED_PAGE_HISTORY = 20;

/**
 * A run of folded rows between two ordinary ones: the IDs between `from`
 * (the row above it, not in it; none at the top of the list) and `to` (its
 * last row, in it), newest first.
 */
export interface Fold {
  readonly kind: "fold";
  /** How many rows it holds, up to `FOLD_COUNT_CAP`. */
  readonly count: number;
  /** Whether it holds more than `count`: past the cap, or past the page. */
  readonly more: boolean;
  readonly from?: string;
  readonly to: string;
}

export type FoldedEntry<T> = { readonly kind: "row"; readonly row: T } | Fold;

/**
 * Where the previous page is: a `before` cursor (none: the newest page), or,
 * when no cursor remembers it, the rows newer than `after`.
 */
export type PreviousPage =
  | { readonly before?: string }
  | { readonly after: string };

export interface FoldedPage<T> {
  /** Ordinary rows and folds, newest first. */
  readonly entries: readonly FoldedEntry<T>[];
  /** `before` of the next page, when there may be older rows. */
  readonly next?: string;
  /** The previous page, when there may be newer rows. */
  readonly previous?: PreviousPage;
}

/** The rows a page may still read; reads and classification spend it. */
export interface ReadBudget {
  left: number;
}

/** One read of the list's index: rows older (`desc`) or newer (`asc`) than `after`. */
export type ReadRows<T> = (input: {
  readonly order: "asc" | "desc";
  readonly after?: string;
  readonly limit: number;
}) => Promise<readonly T[]>;

/**
 * Which rows of a chunk are ordinary: the list's own rule, with its own
 * reads, which spend `budget` too. `newerThan` is the newest row of a
 * page under a cursor: the rows above it are on earlier pages.
 */
export type ClassifyRows<T> = (
  rows: readonly T[],
  context: {
    readonly budget: ReadBudget;
    /** The order `rows` came in: newest first, or oldest first. */
    readonly order: "asc" | "desc";
    readonly newerThan?: string;
  },
) => Promise<ReadonlySet<string>>;

/*
 * A cursor: `s.` (it remembers every page back to the second) or `t.` (it
 * forgot the oldest), then the IDs pages start under, this page's first. A
 * bare ID, as an older link holds, remembers no page.
 */
const SEPARATOR = ".";
const ID = /^[0-9A-Za-z-]+$/u;

interface Cursor {
  /** The ID this page reads under. */
  readonly id: string;
  /** The IDs the pages before it read under, nearest first. */
  readonly history: readonly string[];
  /** Whether `history` reaches the second page. */
  readonly complete: boolean;
}

const parseCursor = (token: string): Cursor => {
  const [mark, ...ids] = token.split(SEPARATOR);
  if ((mark === "s" || mark === "t") && ids.length > 0) {
    if (!ids.every((id) => ID.test(id))) {
      throw new Error("Invalid page cursor.");
    }
    return { id: ids[0]!, history: ids.slice(1), complete: mark === "s" };
  }
  if (!ID.test(token)) throw new Error("Invalid page cursor.");
  return { id: token, history: [], complete: false };
};

const cursorToken = (ids: readonly string[], complete: boolean) => {
  const kept = ids.slice(0, FOLDED_PAGE_HISTORY + 1);
  return [complete && kept.length === ids.length ? "s" : "t", ...kept].join(
    SEPARATOR,
  );
};

interface Scanned<T> {
  readonly row: T;
  /** Whether it counts toward the page: an ordinary row. */
  readonly ordinary: boolean;
  /** Whether it shows as a row: an ordinary one, or the pinned one. */
  readonly shown: boolean;
}

/**
 * Reads from `after` in `order`, a chunk at a time, while the budget lasts,
 * until it finds the ordinary row past `size` of them: the first of the page
 * beyond, which is left out (`beyond`). `ended` when the index ran out.
 */
async function scan<T extends { readonly id: string }>(
  read: ReadRows<T>,
  classify: ClassifyRows<T>,
  order: "asc" | "desc",
  after: string | undefined,
  size: number,
  budget: ReadBudget,
  pinned: string | undefined,
): Promise<{ rows: Scanned<T>[]; ended: boolean; beyond: boolean }> {
  const rows: Scanned<T>[] = [];
  let ordinary = 0;
  let cursor = after;
  // Rows newer than the page's first row are on earlier pages.
  let pageTop: string | undefined;
  while (budget.left > 0) {
    const limit = Math.min(FOLDED_PAGE_CHUNK, budget.left);
    const chunk = await read({
      order,
      limit,
      ...(cursor === undefined ? {} : { after: cursor }),
    });
    budget.left -= chunk.length;
    pageTop ??= chunk[0]?.id;
    const ordinaryIds =
      chunk.length === 0
        ? new Set<string>()
        : await classify(chunk, {
            budget,
            order,
            ...(order === "desc" && after !== undefined && pageTop !== undefined
              ? { newerThan: pageTop }
              : {}),
          });
    for (const row of chunk) {
      const isOrdinary = ordinaryIds.has(row.id);
      if (isOrdinary && ordinary === size) {
        return { rows, ended: false, beyond: true };
      }
      if (isOrdinary) ordinary += 1;
      rows.push({
        row,
        ordinary: isOrdinary,
        shown: isOrdinary || row.id === pinned,
      });
    }
    if (chunk.length < limit) return { rows, ended: true, beyond: false };
    cursor = chunk.at(-1)!.id;
  }
  return { rows, ended: false, beyond: false };
}

/**
 * Rows newest first as entries: each run of folded rows one fold. `above`
 * is the row over the first one; `topContinues` and `bottomContinues` say a
 * run at either edge goes on past the page.
 */
const entriesOf = <T extends { readonly id: string }>(
  rows: readonly Scanned<T>[],
  above: string | undefined,
  { topContinues = false, bottomContinues = false } = {},
): FoldedEntry<T>[] => {
  const entries: FoldedEntry<T>[] = [];
  let run: T[] = [];
  let from = above;
  const close = (continues: boolean) => {
    if (run.length === 0) return;
    entries.push({
      kind: "fold",
      count: Math.min(run.length, FOLD_COUNT_CAP),
      more: run.length > FOLD_COUNT_CAP || continues,
      ...(from === undefined ? {} : { from }),
      to: run.at(-1)!.id,
    });
    run = [];
  };
  for (const { row, shown } of rows) {
    if (shown) {
      close(entries.length === 0 && topContinues);
      entries.push({ kind: "row", row });
      from = row.id;
    } else {
      run.push(row);
    }
  }
  close(bottomContinues || (entries.length === 0 && topContinues));
  return entries;
};

/**
 * One page newest first. `before` is a cursor from `next` or `previous`;
 * `after` reads the page above a row, when no cursor remembers it; neither
 * is the newest page. A page holds `size` ordinary rows and the folds
 * between them, and the run of folded rows under its last ordinary row, so
 * the next page starts with an ordinary row. It reads at most `budget` rows:
 * a page that runs out first ends in a fold that goes on, and the next page
 * continues it.
 */
export async function foldedPage<T extends { readonly id: string }>({
  read,
  classify,
  before,
  after,
  pinned,
  size = FOLDED_PAGE_SIZE,
  budget = FOLDED_PAGE_READ_BUDGET,
}: {
  readonly read: ReadRows<T>;
  readonly classify: ClassifyRows<T>;
  readonly before?: string;
  readonly after?: string;
  /**
   * A row that shows wherever it sits, folded or not, such as the one a
   * link selects: it splits its run, and counts toward no page, so it stays
   * on the page whose run holds it.
   */
  readonly pinned?: string;
  readonly size?: number;
  readonly budget?: number;
}): Promise<FoldedPage<T>> {
  const left: ReadBudget = { left: budget };
  if (after === undefined) {
    const cursor = before === undefined ? undefined : parseCursor(before);
    const { rows, ended } = await scan(
      read,
      classify,
      "desc",
      cursor?.id,
      size,
      left,
      pinned,
    );
    const last = rows.at(-1)?.row.id;
    // Out of budget inside a run: the run goes on past this page.
    const outOfBudget = !ended && left.left === 0;
    const pages = cursor === undefined ? [] : [cursor.id, ...cursor.history];
    const complete = cursor === undefined || cursor.complete;
    const previous = (): PreviousPage | undefined => {
      if (cursor === undefined) return undefined;
      if (cursor.history.length > 0) {
        return { before: cursorToken(cursor.history, cursor.complete) };
      }
      if (cursor.complete) return {};
      return { after: rows[0]?.row.id ?? cursor.id };
    };
    const previousPage = previous();
    return {
      entries: entriesOf(rows, cursor?.id, { bottomContinues: outOfBudget }),
      ...(!ended && last !== undefined
        ? { next: cursorToken([last, ...pages], complete) }
        : {}),
      ...(previousPage === undefined ? {} : { previous: previousPage }),
    };
  }

  // The page above `after`, read upward. The run just above `after` ends
  // that page. A run above its top ordinary row belongs to the page above
  // it when the next ordinary row up is in: the page above starts there. Out
  // of budget, the last row read is kept as the edge, so the read stays in
  // budget and the run over the page's top goes on past it.
  const { rows, ended, beyond } = await scan(
    read,
    classify,
    "asc",
    after,
    size,
    left,
    pinned,
  );
  let top = rows.length;
  let above: string | undefined;
  if (beyond) {
    while (top > 0 && !rows[top - 1]!.ordinary) top -= 1;
    above = rows[top]?.row.id;
  } else if (!ended && rows.length > 0) {
    top -= 1;
    above = rows[top]!.row.id;
  }
  const page = rows.slice(0, top).reverse();
  const first = page[0]?.row.id;
  return {
    entries: entriesOf(page, ended ? undefined : above, {
      topContinues: !ended && !beyond,
    }),
    ...(page.length > 0
      ? { next: cursorToken([page.at(-1)!.row.id], false) }
      : {}),
    ...(!ended && first !== undefined ? { previous: { after: first } } : {}),
  };
}

/**
 * One chunk of a fold's rows, newest first: the rows under `from` (or under
 * `after`, the last row of the chunk before) down to `to`. `next` is the
 * `after` of the next chunk, while the fold goes on.
 */
export async function readFold<T extends { readonly id: string }>({
  read,
  from,
  to,
  after,
  limit = FOLDED_PAGE_CHUNK,
}: {
  readonly read: ReadRows<T>;
  readonly from?: string;
  readonly to: string;
  readonly after?: string;
  readonly limit?: number;
}): Promise<{ readonly rows: readonly T[]; readonly next?: string }> {
  const cursor = after ?? from;
  const chunk = await read({
    order: "desc",
    limit,
    ...(cursor === undefined ? {} : { after: cursor }),
  });
  // IDs order the list, so a row older than `to` is past the fold.
  const rows = chunk.filter(({ id }) => id >= to);
  const last = rows.at(-1)?.id;
  const done =
    rows.length < chunk.length || chunk.length < limit || last === to;
  return { rows, ...(done || last === undefined ? {} : { next: last }) };
}
