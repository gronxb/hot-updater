import type { ApiKeyRow, ChannelRow } from "./databaseRows";

/** The api-keys plugin's storage: key rows by id and by hash. */
export interface ApiKeyModel {
  create(row: ApiKeyRow): Promise<"created" | "existing">;
  findByHash(hash: string): Promise<ApiKeyRow | null>;
  list(): Promise<readonly ApiKeyRow[]>;
  revoke(input: {
    readonly id: string;
    readonly revokedAtMs: number;
  }): Promise<ApiKeyRow | null>;
}

export interface ChannelInsertResult {
  readonly row: ChannelRow;
  readonly inserted: boolean;
}

export type ChannelDeleteResult =
  | { readonly deleted: true }
  | {
      readonly deleted: false;
      readonly reason: "not_found" | "not_empty";
    };
