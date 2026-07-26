import {
  attachCapabilityContribution,
  defineCapability,
  type HotUpdaterFeatureInvocation,
  type StorageInvocationToken,
  type StoragePluginV2,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "./createHotUpdaterCore";
import {
  defineFirstPartyFeatureManifest,
  type FeatureApiKind,
  requireHotUpdaterFeatureInvocation,
} from "./internal/first-party-plugin";
import { createRuntimeDatabase } from "./runtime.testFixtures";
import { StorageInvocationAuthority } from "./storageInvocation";

type PlatformContext = Readonly<{ readonly requestId: string }>;
type AuthorityApi<TContext> = Readonly<{
  fail(context?: TContext): Promise<never>;
  read(context?: TContext): Promise<string | null>;
}>;

interface AuthorityFeatureKind extends FeatureApiKind {
  readonly availableApi: AuthorityApi<this["context"]>;
  readonly feature: AuthorityApi<this["context"]> & {
    readonly status: "available";
  };
}

type ReaderCapability = Readonly<{
  read(token: StorageInvocationToken): Promise<string | null>;
}>;

const readerToken = defineCapability<ReaderCapability>({
  id: "authority-reader@1",
  parse(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof Reflect.get(value, "read") !== "function"
    ) {
      throw new TypeError("Invalid authority reader.");
    }
    return Object.freeze({
      read(token) {
        return Reflect.apply(Reflect.get(value, "read"), value, [token]);
      },
    });
  },
});

describe("runtime feature invocation authority acceptance", () => {
  it("isolates A→undefined→A and concurrent namespace, alias, route, and throw tokens", async () => {
    // Given
    const begin = vi.spyOn(StorageInvocationAuthority.prototype, "begin");
    const bind = vi.spyOn(StorageInvocationAuthority.prototype, "bind");
    const close = vi.spyOn(StorageInvocationAuthority.prototype, "close");
    const platformContexts: unknown[] = [];
    const tokens: StorageInvocationToken[] = [];
    const providerContexts: string[] = [];
    let retainedReader: ReaderCapability | undefined;
    const storage: StoragePluginV2 = {
      name: "authority-storage",
      protocol: "s3",
      async put() {
        throw new Error("unused");
      },
      async head() {
        return { kind: "not-found" };
      },
      async get({ context, storageUri }) {
        const boundaryId = String(context.bindings.boundaryId);
        providerContexts.push(boundaryId);
        return {
          kind: "found",
          storageUri,
          body: new Blob([boundaryId]).stream(),
          metadata: { contentLength: boundaryId.length },
        };
      },
      async delete() {
        return { kind: "not-found" };
      },
    };
    const carrier = attachCapabilityContribution(storage, {
      token: readerToken,
      create(runtime) {
        const guarded = runtime.storages.find(
          ({ supportedProtocol }) => supportedProtocol === "s3",
        );
        if (guarded === undefined) throw new Error("missing guarded storage");
        retainedReader = Object.freeze({
          read(token: StorageInvocationToken) {
            return guarded.readText("s3://bucket/authority", token);
          },
        });
        return retainedReader;
      },
    });
    const feature = defineFirstPartyFeatureManifest<
      "authority",
      AuthorityFeatureKind,
      { readonly legacyAuthorityRead: "read" }
    >({
      aliases: { legacyAuthorityRead: "read" },
      featureApi: "required",
      id: "authority-feature",
      namespace: "authority",
      requires: [{ missing: "error", token: readerToken }],
      setup({ capabilities }) {
        const reader = capabilities.require(readerToken);
        const active = (
          context: unknown,
          invocation: HotUpdaterFeatureInvocation<unknown> | undefined,
        ) => {
          const current = requireHotUpdaterFeatureInvocation(invocation);
          platformContexts.push(context);
          tokens.push(current.storageToken);
          return current;
        };
        return {
          api: {
            invocation: {
              fail: { contextIndex: 0, publicArity: 1 },
              read: { contextIndex: 0, publicArity: 1 },
            },
            legacyAliases: { legacyAuthorityRead: "read" },
            namespace: "authority",
            value: {
              async fail(
                context?: unknown,
                invocation?: HotUpdaterFeatureInvocation<unknown>,
              ): Promise<never> {
                const current = active(context, invocation);
                await reader.read(current.storageToken);
                throw new Error("feature failure");
              },
              async read(
                context?: unknown,
                invocation?: HotUpdaterFeatureInvocation<unknown>,
              ) {
                const current = active(context, invocation);
                return reader.read(current.storageToken);
              },
              status: "available",
            },
          },
          routes: [
            {
              access: { kind: "public" },
              id: "authority.route",
              method: "GET",
              path: "/authority",
              async handle(context) {
                const current = requireHotUpdaterFeatureInvocation(
                  Reflect.get(context, "invocation"),
                );
                platformContexts.push(context.platformContext);
                tokens.push(current.storageToken);
                return new Response(await reader.read(current.storageToken));
              },
            },
          ],
        };
      },
      version: "1.0.0",
    });
    let resolverOrdinal = 0;
    const resolverInputs: string[] = [];
    const resolverOperations: Array<{
      invokedAlias?: string;
      member: string;
    }> = [];
    const hotUpdater = createHotUpdater<
      PlatformContext,
      readonly [typeof feature]
    >({
      database: createRuntimeDatabase(),
      plugins: [feature],
      storages: [carrier],
      storageContext(input) {
        resolverOrdinal += 1;
        const label = input.context?.requestId ?? "undefined";
        const boundaryId = `${resolverOrdinal}:${input.operation.member}:${label}`;
        resolverInputs.push(boundaryId);
        resolverOperations.push({
          member: input.operation.member,
          ...("invokedAlias" in input.operation &&
          input.operation.invokedAlias !== undefined
            ? { invokedAlias: input.operation.invokedAlias }
            : {}),
        });
        return {
          target: "worker",
          environment: {},
          bindings: { boundaryId },
        };
      },
    });
    const sharedA: PlatformContext = Object.freeze({ requestId: "A" });

    // When
    const firstA = await hotUpdater.features.authority.read(sharedA);
    const between = await hotUpdater.features.authority.read();
    const secondA = await hotUpdater.legacyAuthorityRead(sharedA);
    const sequentialAuthorityCounts = {
      begin: begin.mock.calls.length,
      bind: bind.mock.calls.length,
      close: close.mock.calls.length,
    };
    const concurrent = await Promise.all([
      hotUpdater.features.authority.read(sharedA),
      hotUpdater.features.authority.read(),
      hotUpdater.handler(
        new Request("https://example.com/api/authority"),
        sharedA,
      ),
      hotUpdater.features.authority
        .fail(sharedA)
        .catch((error: unknown) =>
          error instanceof Error ? error.message : String(error),
        ),
    ]);

    // Then
    expect([firstA, between, secondA]).toEqual([
      "1:read:A",
      "2:read:undefined",
      "3:read:A",
    ]);
    expect(sequentialAuthorityCounts).toEqual({
      begin: 3,
      bind: 3,
      close: 3,
    });
    expect(concurrent.slice(0, 2)).toEqual(["4:read:A", "5:read:undefined"]);
    await expect((concurrent[2] as Response).text()).resolves.toMatch(
      /^[67]:authority\.route:A$/u,
    );
    expect(concurrent[3]).toBe("feature failure");
    expect(resolverInputs.slice(0, 5)).toEqual([
      "1:read:A",
      "2:read:undefined",
      "3:read:A",
      "4:read:A",
      "5:read:undefined",
    ]);
    expect(new Set(resolverInputs.slice(5))).toEqual(
      new Set(["6:fail:A", "7:authority.route:A"]),
    );
    expect(resolverOperations).toEqual([
      { member: "read" },
      { member: "read" },
      { invokedAlias: "legacyAuthorityRead", member: "read" },
      { member: "read" },
      { member: "read" },
      { member: "fail" },
      { member: "authority.route" },
    ]);
    expect(providerContexts).toEqual(resolverInputs);
    expect(platformContexts).toEqual([
      sharedA,
      undefined,
      sharedA,
      sharedA,
      undefined,
      sharedA,
      sharedA,
    ]);
    expect(new Set(tokens).size).toBe(7);
    expect(resolverOrdinal).toBe(7);
    expect(begin).toHaveBeenCalledTimes(7);
    expect(bind).toHaveBeenCalledTimes(7);
    expect(close).toHaveBeenCalledTimes(7);
    if (retainedReader === undefined) {
      throw new Error("Expected retained reader.");
    }
    const providerCalls = providerContexts.length;
    for (const token of tokens) {
      await expect(retainedReader.read(token)).rejects.toMatchObject({
        code: "invalid-storage-invocation",
      });
    }
    expect(providerContexts).toHaveLength(providerCalls);
    vi.restoreAllMocks();
  });
});
