import type { ChannelRow, NativeBuildRow } from "./databaseRows";

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

/**
 * What `deleteNativeBuild` did: the deleted build, whose artifact the caller
 * deletes from storage, since no row names it any more.
 */
export type NativeBuildDeleteResult =
  | { readonly deleted: true; readonly nativeBuild: NativeBuildRow }
  | { readonly deleted: false; readonly reason: "not_found" };
