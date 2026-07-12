declare module "node:sqlite" {
  export type SqliteValue = bigint | null | number | string | Uint8Array;

  export interface StatementSync {
    all: () => Record<string, SqliteValue>[];
    get: () => Record<string, SqliteValue> | undefined;
  }

  export class DatabaseSync {
    constructor(location: string);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
