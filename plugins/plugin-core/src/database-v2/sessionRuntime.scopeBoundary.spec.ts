import { describe, expect, it } from "vitest";

import { maliciousScopeCases } from "./sessionRuntime.scopeBoundaryCases";
import { expectConnectorErrorCode } from "./sessionRuntime.testAssertions";
import { createRuntimeScope } from "./sessionRuntime.testFixtures";
import { setupRuntimeTestHarness } from "./sessionRuntime.testHarness";
import type { MutableScopeFixture } from "./sessionRuntime.testTypes";

const openUntypedSession = (
  connection: object,
  scope: unknown,
): Promise<unknown> =>
  Reflect.apply(Reflect.get(connection, "openSession"), connection, [scope]);

describe("database-v2 untyped asserted-scope boundary", () => {
  const createSubject = setupRuntimeTestHarness();

  for (const maliciousCase of maliciousScopeCases()) {
    it(`rejects ${maliciousCase.label} without observing it`, async () => {
      // Given an untrusted runtime value and observable digest/backend seams
      let digestCalls = 0;
      let getterCalls = 0;
      const { backend, connection } = createSubject<
        MutableScopeFixture["context"]
      >({
        sha256: () => {
          digestCalls += 1;
          return new Uint8Array(32);
        },
      });
      const scope = maliciousCase.create(() => {
        getterCalls += 1;
      });

      // When the value crosses the typed openSession boundary
      await expectConnectorErrorCode(
        () => openUntypedSession(connection, scope),
        "INVALID_SCOPE",
      );

      // Then parsing causes no getter, digest, or backend side effect
      expect(getterCalls).toBe(0);
      expect(digestCalls).toBe(0);
      expect(backend.readAttempts).toBe(0);
      expect(backend.commitAttempts).toBe(0);
      expect(backend.observedScopes).toEqual([]);
    });
  }

  it("captures asserted IDs once before asynchronous hashing", async () => {
    // Given a valid mutable scope and a digest held after scope parsing
    let digestEnteredResolve: (() => void) | undefined;
    let digestReleaseResolve: (() => void) | undefined;
    const digestEntered = new Promise<void>((resolve) => {
      digestEnteredResolve = resolve;
    });
    const digestRelease = new Promise<void>((resolve) => {
      digestReleaseResolve = resolve;
    });
    const { backend, connection } = createSubject<
      MutableScopeFixture["context"]
    >({
      sha256: async () => {
        digestEnteredResolve?.();
        await digestRelease;
        return new Uint8Array(32);
      },
    });
    const scope = createRuntimeScope();

    // When the source is mutated while hashing the captured identity
    const pendingSession = connection.openSession(scope);
    await digestEntered;
    scope.tenantId = "mutated-tenant";
    scope.principalId = "mutated-principal";
    scope.context = { marker: "mutated-context" };
    digestReleaseResolve?.();
    const session = await pendingSession;
    await session.bundles.get("bundle-a");

    // Then the backend sees only the original data-descriptor values
    expect(backend.observedScopes[0]).toMatchObject({
      tenantId: "tenant-a",
      principalId: "principal-a",
    });
  });

  it("keeps nested context lookalikes opaque", async () => {
    // Given context values whose own identifiers are accessor-backed lookalikes
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    let contextGetterCalls = 0;
    const context = { marker: "opaque-context" };
    Object.defineProperties(context, {
      tenantId: {
        enumerable: true,
        get: () => {
          contextGetterCalls += 1;
          return "spoofed-tenant";
        },
      },
      principalId: {
        enumerable: true,
        get: () => {
          contextGetterCalls += 1;
          return "spoofed-principal";
        },
      },
    });

    // When a session opens and performs a backend read
    const session = await connection.openSession({
      tenantId: "tenant-a",
      principalId: "principal-a",
      context,
    });
    await session.bundles.get("bundle-a");

    // Then context is not inspected and cannot override asserted IDs
    expect(contextGetterCalls).toBe(0);
    expect(backend.observedScopes[0]).toMatchObject({
      tenantId: "tenant-a",
      principalId: "principal-a",
    });
  });
});
