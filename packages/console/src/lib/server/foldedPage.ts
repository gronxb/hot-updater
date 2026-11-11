/*
 * A list page that counts only its ordinary rows, the ones a list leads with
 * (a reachable bundle, the newest build of a distribution path), and folds
 * every run of other rows between them into one entry: how many rows it
 * holds and where they lie, never the rows themselves. A fold's rows load
 * when someone opens it. Pages read ahead through the list's own index, up to
 * a budget, and keep no state: the next page starts where this one stopped.
 */

/** How many ordinary rows one page shows. */
export const FOLDED_PAGE_SIZE = 20;

/** The most rows one page reads, ordinary and folded together. */
export const FOLDED_PAGE_READ_BUDGET = 200;

/** How many rows one read of the index takes. */
export const FOLDED_PAGE_CHUNK = 50;

/** The count a fold shows exactly; past it, "100+". */
export const FOLD_COUNT_CAP = 100;

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

export interface FoldedPage<T> {
  /** Ordinary rows and folds, newest first. */
  readonly entries: readonly FoldedEntry<T>[];
  /** `before` of the next page, when there may be older rows. */
  readonly next?: string;
  /** `after` of the previous page, when there may be newer rows. */
  readonly previous?: string;
}

/** One read of the list's index: rows older (`desc`) or newer (`asc`) than `after`. */
export type ReadRows<T> = (input: {
  readonly order: "asc" | "desc";
  readonly after?: string;
  readonly limit: number;
}) => Promise<readonly T[]>;

/** Which rows of a chunk are ordinary: the list's own rule, with its own reads. */
export type ClassifyRows<T> = (
  rows: readonly T[],
) => Promise<ReadonlySet<string>>;

interface Scanned<T> {
  readonly row: T;
  /** Whether it counts toward the page: an ordinary row. */
  readonly ordinary: boolean;
  /** Whether it shows as a row: an ordinary one, or the pinned one. */
  readonly shown: boolean;
}

/**
 * Reads up to `budget` rows from `after` in `order`, a chunk at a time,
 * until it finds the ordinary row past `size` of them: the first of the
 * page beyond. That row is left out. `ended` when the index ran out.
 */
async function scan<T extends { readonly id: string }>(
  read: ReadRows<T>,
  classify: ClassifyRows<T>,
  order: "asc" | "desc",
  after: string | undefined,
  size: number,
  budget: number,
  pinned: string | undefined,
): Promise<{ rows: Scanned<T>[]; ended: boolean; beyond: boolean }> {
  const rows: Scanned<T>[] = [];
  let ordinary = 0;
  let cursor = after;
  while (rows.length < budget) {
    const limit = Math.min(FOLDED_PAGE_CHUNK, budget - rows.length);
    const chunk = await read({
      order,
      limit,
      ...(cursor === undefined ? {} : { after: cursor }),
    });
    const ordinaryIds = chunk.length === 0 ? new Set() : await classify(chunk);
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

/** Rows newest first as entries: each run of folded rows one fold. */
const entriesOf = <T extends { readonly id: string }>(
  rows: readonly Scanned<T>[],
  above: string | undefined,
  lastRunContinues: boolean,
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
      close(false);
      entries.push({ kind: "row", row });
      from = row.id;
    } else {
      if (run.length === 0 && entries.at(-1)?.kind === "row") {
        from = (entries.at(-1) as { row: T }).row.id;
      }
      run.push(row);
    }
  }
  close(lastRunContinues);
  return entries;
};

/**
 * One page newest first: `before` reads older rows for the next page,
 * `after` newer ones for the previous page, neither the newest page. A page
 * holds `size` ordinary rows and the folds between them, and the run of
 * folded rows under its last ordinary row, so the next page starts with an
 * ordinary row. It reads at most `budget` rows: a page that runs out of
 * budget first ends in a fold that goes on, and the next page continues it.
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
  if (after === undefined) {
    const { rows, ended } = await scan(
      read,
      classify,
      "desc",
      before,
      size,
      budget,
      pinned,
    );
    const last = rows.at(-1)?.row.id;
    // Out of budget inside a run: the run goes on past this page.
    const outOfBudget = !ended && rows.length === budget;
    return {
      entries: entriesOf(rows, before, outOfBudget),
      ...(!ended && last !== undefined ? { next: last } : {}),
      ...(before !== undefined && rows.length > 0
        ? { previous: rows[0]!.row.id }
        : {}),
    };
  }

  // The page above `after`: read upward. The run just above `after` is the
  // end of that page; a run above its top ordinary row belongs to the page
  // above it, so it is left out unless the list ends there.
  const { rows, ended } = await scan(
    read,
    classify,
    "asc",
    after,
    size,
    budget,
    pinned,
  );
  let top = rows.length;
  if (!ended && rows.some(({ ordinary }) => ordinary)) {
    while (!rows[top - 1]!.ordinary) top -= 1;
  }
  const page = rows.slice(0, top).reverse();
  const first = page[0]?.row.id;
  const reachedTop = ended && top === rows.length;
  // A page of folded rows alone, out of budget: the row above its fold is
  // the next one up, one more read.
  const above =
    reachedTop || page[0]?.shown !== false
      ? undefined
      : (await read({ order: "asc", after: rows.at(-1)!.row.id, limit: 1 }))[0]
          ?.id;
  const entries = entriesOf(page, above, false);
  return {
    // Folded rows alone, out of budget: the run goes on above this page too.
    entries:
      !reachedTop && entries.length === 1 && entries[0]!.kind === "fold"
        ? [{ ...entries[0]!, more: true }]
        : entries,
    ...(page.length > 0 ? { next: page.at(-1)!.row.id } : {}),
    ...(!reachedTop && first !== undefined ? { previous: first } : {}),
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
