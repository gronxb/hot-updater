import type { ChannelRow } from "./databaseRows";

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
