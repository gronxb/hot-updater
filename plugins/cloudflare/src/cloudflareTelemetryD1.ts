type D1Result<TRow> = {
  readonly results?: readonly TRow[];
};

type D1PreparedStatement = {
  bind: (...values: readonly unknown[]) => {
    all: <TRow>() => Promise<D1Result<TRow>>;
    first: <TRow>() => Promise<TRow | null>;
    run: () => Promise<unknown>;
  };
};

export type CloudflareTelemetryD1Database = {
  prepare: (sql: string) => D1PreparedStatement;
};

export const queryFirst = async <TRow>(
  db: CloudflareTelemetryD1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<TRow | null> =>
  db
    .prepare(sql)
    .bind(...params)
    .first<TRow>();

export const queryAll = async <TRow>(
  db: CloudflareTelemetryD1Database,
  sql: string,
  params: readonly unknown[] = [],
): Promise<readonly TRow[]> => {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<TRow>();
  return result.results ?? [];
};

export const runD1 = (
  db: CloudflareTelemetryD1Database,
  sql: string,
  params: readonly unknown[] = [],
) =>
  db
    .prepare(sql)
    .bind(...params)
    .run();
