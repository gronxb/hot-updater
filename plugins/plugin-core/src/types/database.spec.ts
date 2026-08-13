import { describe, expectTypeOf, it } from "vitest";

import type {
  BundlePatchRow,
  BundleRepositoryChange,
  BundleRepositoryCommit,
  BundleRow,
  ChannelRow,
  DatabaseBundleMetadata,
  DatabaseChange,
  DatabaseCommitResult,
  DatabasePlugin,
} from "./database";

describe("database plugin types", () => {
  it("exposes five nested official models", () => {
    expectTypeOf<
      DatabasePlugin["models"]["bundles"]["findById"]
    >().returns.resolves.toEqualTypeOf<BundleRow | null>();
    expectTypeOf<
      DatabasePlugin["models"]["bundlePatches"]["findByBundleIds"]
    >().returns.resolves.toEqualTypeOf<readonly BundlePatchRow[]>();
    expectTypeOf<
      DatabasePlugin["models"]["channels"]["list"]
    >().returns.resolves.toEqualTypeOf<{
      readonly channels: readonly ChannelRow[];
    }>();
    expectTypeOf<DatabasePlugin>().not.toHaveProperty("bundles");
    expectTypeOf<DatabasePlugin>().not.toHaveProperty("getChannels");
  });

  it("keeps model-specific changes discriminated", () => {
    expectTypeOf<{
      readonly model: "bundles";
      readonly operation: "insert";
      readonly row: BundlePatchRow;
    }>().not.toMatchTypeOf<DatabaseChange>();
    expectTypeOf<{
      readonly model: "bundlePatches";
      readonly operation: "insert";
      readonly row: BundleRow;
    }>().not.toMatchTypeOf<DatabaseChange>();
    expectTypeOf<{
      readonly model: "analytics";
      readonly operation: "append";
      readonly row: never;
    }>().not.toMatchTypeOf<DatabaseChange>();
  });

  it("matches BundleRepository commits to the standalone atomic boundary", () => {
    expectTypeOf<{
      readonly model: "analytics";
      readonly operation: "insert";
      readonly row: never;
    }>().not.toMatchTypeOf<BundleRepositoryChange>();
    expectTypeOf<{
      readonly model: "clientAccessKeys";
      readonly operation: "insert";
      readonly row: never;
      readonly onConflict: "ignore";
    }>().not.toMatchTypeOf<BundleRepositoryChange>();
    expectTypeOf<{
      readonly changes: readonly [
        {
          readonly model: "channels";
          readonly operation: "delete";
          readonly where: { readonly id: "channel-1" };
        },
      ];
    }>().toMatchTypeOf<BundleRepositoryCommit>();
    expectTypeOf<{
      readonly changes: readonly [
        {
          readonly model: "channels";
          readonly operation: "delete";
          readonly where: { readonly id: "channel-1" };
        },
        {
          readonly model: "bundles";
          readonly operation: "delete";
          readonly where: { readonly id: "bundle-1" };
        },
      ];
    }>().not.toMatchTypeOf<BundleRepositoryCommit>();
    expectTypeOf<{
      readonly changes: readonly [
        {
          readonly model: "analytics";
          readonly operation: "insert";
          readonly row: never;
        },
      ];
    }>().not.toMatchTypeOf<BundleRepositoryCommit>();
    expectTypeOf<{
      readonly changes: readonly [];
    }>().toMatchTypeOf<BundleRepositoryCommit>();
  });

  it("keeps the remote bundle repository narrower than a database plugin", () => {
    expectTypeOf<{
      readonly model: "channels";
      readonly operation: "delete";
      readonly where: { readonly id: "channel-1" };
    }>().toMatchTypeOf<BundleRepositoryChange>();
    expectTypeOf<{
      readonly model: "analytics";
      readonly operation: "insert";
      readonly row: never;
    }>().not.toMatchTypeOf<BundleRepositoryChange>();
    expectTypeOf<{
      readonly model: "clientAccessKeys";
      readonly operation: "update";
      readonly where: { readonly id: "key-1" };
      readonly update: { readonly revokedAtMs: 1 };
    }>().not.toMatchTypeOf<BundleRepositoryChange>();
  });

  it("rejects policy fields on immutable Bundle updates", () => {
    expectTypeOf<{
      readonly model: "bundles";
      readonly operation: "update";
      readonly where: { readonly id: "bundle-1" };
      readonly update: {
        readonly channel: "preview";
        readonly channel_id: "channel-2";
      };
    }>().not.toMatchTypeOf<DatabaseChange>();
  });

  it("uses only generic commit result semantics", () => {
    expectTypeOf<
      | { readonly committed: true }
      | {
          readonly committed: false;
          readonly conflict:
            | {
                readonly changeIndex: number;
                readonly reason: "not_found" | "referenced";
              }
            | {
                readonly changeIndex: -1;
                readonly reason: "version_conflict";
                readonly model: "releases" | "releaseCatalogs";
                readonly key: string;
                readonly expectedVersion: number | null;
                readonly actualVersion: number | null;
              };
        }
    >().toEqualTypeOf<DatabaseCommitResult>();
  });

  it("restricts bundle metadata to JSON objects", () => {
    expectTypeOf<
      BundleRow["metadata"]
    >().toEqualTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<{
      readonly app_version: "1.0.0";
      readonly release: {
        readonly flags: readonly [true, null, 3, "stable"];
      };
    }>().toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<string>().not.toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<readonly []>().not.toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<bigint>().not.toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<() => true>().not.toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<{
      readonly nested: undefined;
    }>().not.toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<{
      readonly nested: () => true;
    }>().not.toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<{
      readonly app_version: 1;
    }>().not.toMatchTypeOf<DatabaseBundleMetadata>();
  });
});
