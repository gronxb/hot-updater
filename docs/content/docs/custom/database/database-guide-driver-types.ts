export const betterSqlite3Types = `export interface Options {
  readonly readonly?: boolean;
}
export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}
export interface Statement {
  readonly reader: boolean;
  all(parameters: ReadonlyArray<unknown>): unknown[];
  run(parameters: ReadonlyArray<unknown>): RunResult;
  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>;
}
export declare class Database {
  constructor(filename: string, options?: Options);
  close(): void;
  prepare(sql: string): Statement;
}
export default Database;
`;

export const pgTypes = `export interface PoolConfig {
  readonly connectionString?: string;
}
export interface Cursor<T> {
  read(rowsCount: number): Promise<T[]>;
  close(): Promise<void>;
}
export interface QueryResult<R> {
  readonly command: "UPDATE" | "DELETE" | "INSERT" | "SELECT" | "MERGE";
  readonly rowCount: number;
  readonly rows: R[];
}
export interface PoolClient {
  query<R>(sql: string, parameters: ReadonlyArray<unknown>): Promise<QueryResult<R>>;
  query<R>(cursor: Cursor<R>): Cursor<R>;
  release(): void;
}
export declare class Pool {
  constructor(config?: PoolConfig | string);
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}
declare const pg: { readonly Pool: typeof Pool };
export default pg;
`;
