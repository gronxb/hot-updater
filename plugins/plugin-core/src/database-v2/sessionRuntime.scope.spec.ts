import { describe, expect, it } from "vitest";

import { expectConnectorErrorCode } from "./sessionRuntime.testAssertions";
import {
  createRuntimeScope,
  setupRuntimeSubject,
} from "./sessionRuntime.testFixtures";
import { setupRuntimeTestHarness } from "./sessionRuntime.testHarness";
import type { MutableScopeFixture } from "./sessionRuntime.testTypes";

describe("database-v2 asserted scope runtime", () => {
  const createSubject = setupRuntimeTestHarness();

  it("rejects empty asserted identifiers before backend I/O", async () => {
    // Given a fresh connection and two malformed trusted-host assertions
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();

    // When each assertion is opened
    await expectConnectorErrorCode(
      () =>
        connection.openSession({
          tenantId: "",
          principalId: "principal-a",
          context: { marker: "empty-tenant" },
        }),
      "INVALID_SCOPE",
    );
    await expectConnectorErrorCode(
      () =>
        connection.openSession({
          tenantId: "tenant-a",
          principalId: "   ",
          context: { marker: "empty-principal" },
        }),
      "INVALID_SCOPE",
    );

    // Then no backend operation sees either assertion
    expect(backend.readAttempts).toBe(0);
    expect(backend.commitAttempts).toBe(0);
    expect(backend.observedScopes).toEqual([]);
  });

  it("binds asserted IDs immutably and never trusts context lookalikes", async () => {
    // Given a mutable assertion whose context contains spoof-like identifiers
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const scope = createRuntimeScope();
    const session = await connection.openSession(scope);

    // When the caller mutates the source assertion after opening and reads
    scope.tenantId = "mutated-tenant";
    scope.principalId = "mutated-principal";
    scope.context.tenantId = "mutated-context-tenant";
    await session.bundles.get("bundle-a");

    // Then only the original trusted assertion reaches the backend
    expect(backend.observedScopes).toHaveLength(1);
    expect(backend.observedScopes[0]).toMatchObject({
      tenantId: "tenant-a",
      principalId: "principal-a",
    });
    expect(backend.observedScopes[0]).not.toMatchObject({
      tenantId: "context-tenant-must-not-win",
      principalId: "context-principal-must-not-win",
    });
  });

  it("fails a pending open when close begins before scope hashing completes", async () => {
    // Given a scope digest and owned disposal held on deterministic gates
    let digestEnteredResolve: (() => void) | undefined;
    let digestReleaseResolve: (() => void) | undefined;
    let disposeReleaseResolve: (() => void) | undefined;
    const digestEntered = new Promise<void>((resolve) => {
      digestEnteredResolve = resolve;
    });
    const digestRelease = new Promise<void>((resolve) => {
      digestReleaseResolve = resolve;
    });
    const disposeRelease = new Promise<void>((resolve) => {
      disposeReleaseResolve = resolve;
    });
    const subject = setupRuntimeSubject<MutableScopeFixture["context"]>(
      await import("./sessionRuntime.testLoader").then((module) =>
        module.loadConnectionRuntimeFactory(),
      ),
      {
        sha256: async () => {
          digestEnteredResolve?.();
          await digestRelease;
          return new Uint8Array(32);
        },
        dispose: async () => await disposeRelease,
      },
    );
    const pendingOpen = subject.connection.openSession(createRuntimeScope());
    await digestEntered;

    // When connection close starts before the digest is released
    const pendingClose = subject.connection.close();
    digestReleaseResolve?.();

    // Then the open observes the closing state and no backend I/O occurs
    await expectConnectorErrorCode(() => pendingOpen, "CONNECTION_CLOSING");
    expect(subject.backend.commitAttempts).toBe(0);
    expect(subject.backend.readAttempts).toBe(0);
    disposeReleaseResolve?.();
    await pendingClose;
  });
});
