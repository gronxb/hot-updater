declare module "node:sqlite" {
  export type SqliteValue = bigint | null | number | string | Uint8Array;

  export interface StatementSync {
    all: (...parameters: SqliteValue[]) => Record<string, SqliteValue>[];
    columns: () => readonly unknown[];
    get: (
      ...parameters: SqliteValue[]
    ) => Record<string, SqliteValue> | undefined;
    iterate: (
      ...parameters: SqliteValue[]
    ) => IterableIterator<Record<string, SqliteValue>>;
    run: (...parameters: SqliteValue[]) => {
      readonly changes: number | bigint;
      readonly lastInsertRowid: number | bigint;
    };
  }

  export class DatabaseSync {
    constructor(location: string);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
