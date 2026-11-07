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

/**
 * A store build mark's result: the build, and the build whose mark it replaced,
 * or null when it replaced none.
 */
export interface NativeBuildMarkResult {
  readonly nativeBuild: NativeBuildRow;
  readonly previous: NativeBuildRow | null;
}
