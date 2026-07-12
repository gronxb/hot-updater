import { describe, expect, it } from "vitest";

import { expectConnectorErrorCode } from "./sessionRuntime.testAssertions";
import { RuntimeDeferred } from "./sessionRuntime.testBackend";
import {
  CHANGE_SET_IDS,
  createRuntimeChangeSet,
  createRuntimeScope,
} from "./sessionRuntime.testFixtures";
import { setupRuntimeTestHarness } from "./sessionRuntime.testHarness";
import type { MutableScopeFixture } from "./sessionRuntime.testTypes";

const invokeDuringPrototypeInspection = (
  changeSet: ReturnType<typeof createRuntimeChangeSet>,
  action: () => void,
): ReturnType<typeof createRuntimeChangeSet> => {
  let invoked = false;
  return new Proxy(changeSet, {
    getPrototypeOf: (target) => {
      if (!invoked) {
        invoked = true;
        action();
      }
      return Reflect.getPrototypeOf(target);
    },
  });
};

describe("database-v2 connection and session lifecycle", () => {
  const createSubject = setupRuntimeTestHarness();

  it("waits for an active commit when closing only the session", async () => {
    // Given an owned resource and a backend commit held in flight
    let disposalCount = 0;
    const { backend, connection } = createSubject<
      MutableScopeFixture["context"]
    >({
      dispose: async () => {
        disposalCount += 1;
      },
    });
    const session = await connection.openSession(createRuntimeScope());
    const entered = backend.holdNextCommit();
    const commit = session.applyChangeSet(
      createRuntimeChangeSet(CHANGE_SET_IDS.first),
    );
    await entered;

    // When session close starts while the commit is active
    const close = session.close();
    const state = await Promise.race([
      close.then(() => "closed" as const),
      Promise.resolve("pending" as const),
    ]);

    // Then close waits, commit completes, and the connection resource remains alive
    expect(state).toBe("pending");
    expect(disposalCount).toBe(0);
    backend.releaseCommit();
    await expect(commit).resolves.toMatchObject({ outcome: "committed" });
    await close;
    expect(disposalCount).toBe(0);
    await expectConnectorErrorCode(
      () => session.bundles.channels(),
      "SESSION_CLOSED",
    );
  });

  it("registers an active commit before a digest callback can close", async () => {
    // Given a digest callback that reentrantly closes a session before commit I/O
    let digestCalls = 0;
    let closeSession = (): Promise<void> =>
      Promise.reject(new TypeError("session has not opened"));
    let reentrantClose: Promise<void> | undefined;
    const order: string[] = [];
    const { backend, connection } = createSubject<
      MutableScopeFixture["context"]
    >({
      sha256: () => {
        digestCalls += 1;
        if (digestCalls === 2) {
          reentrantClose = closeSession();
        }
        return new Uint8Array(32);
      },
    });
    const session = await connection.openSession(createRuntimeScope());
    closeSession = async () => await session.close();

    // When change-set hashing invokes the reentrant close
    const commit = session.applyChangeSet(
      createRuntimeChangeSet(CHANGE_SET_IDS.first),
    );
    await Promise.resolve();
    const close = reentrantClose;
    if (close === undefined) {
      throw new TypeError("digest callback did not close the session");
    }
    const observedClose = close.then(() => {
      order.push("close");
    });
    const observedCommit = commit.then((receipt) => {
      order.push("commit");
      return receipt;
    });

    // Then close remains behind the registered commit until durability completes
    await expect(observedCommit).resolves.toMatchObject({
      outcome: "committed",
    });
    await expect(observedClose).resolves.toBeUndefined();
    expect(order).toEqual(["commit", "close"]);
    expect(backend.commitAttempts).toBe(1);
  });

  it("registers an active commit before input inspection can close", async () => {
    // Given a transparent input proxy that closes during snapshot inspection
    const order: string[] = [];
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    let reentrantClose: Promise<void> | undefined;
    const changeSet = invokeDuringPrototypeInspection(
      createRuntimeChangeSet(CHANGE_SET_IDS.first),
      () => {
        reentrantClose = session.close();
      },
    );

    // When applying the change set enters caller-controlled inspection
    const commit = session.applyChangeSet(changeSet).then((receipt) => {
      order.push("commit");
      return receipt;
    });
    const close = reentrantClose;
    if (close === undefined) {
      throw new TypeError("input inspection did not close the session");
    }
    const observedClose = close.then(() => {
      order.push("close");
    });

    // Then close stays behind the reserved commit until durability completes
    await expect(commit).resolves.toMatchObject({ outcome: "committed" });
    await expect(observedClose).resolves.toBeUndefined();
    expect(order).toEqual(["commit", "close"]);
    expect(backend.commitAttempts).toBe(1);
  });

  it("rejects a reentrant commit during input inspection", async () => {
    // Given a transparent input proxy that starts another commit during snapshot
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    let reentrantCommit: Promise<unknown> | undefined;
    const outer = invokeDuringPrototypeInspection(
      createRuntimeChangeSet(CHANGE_SET_IDS.first),
      () => {
        reentrantCommit = session.applyChangeSet(
          createRuntimeChangeSet(CHANGE_SET_IDS.second),
        );
      },
    );

    // When the outer commit crosses its caller-controlled input boundary
    const committed = session.applyChangeSet(outer);
    const concurrent = reentrantCommit;
    if (concurrent === undefined) {
      throw new TypeError("input inspection did not attempt a second commit");
    }

    // Then the reserved slot rejects the nested commit and admits only the outer
    await expectConnectorErrorCode(() => concurrent, "CONCURRENT_COMMIT");
    await expect(committed).resolves.toMatchObject({ outcome: "committed" });
    expect(backend.commitAttempts).toBe(1);
    await connection.close();
  });

  it("automatically closes idle and poisoned children without hanging", async () => {
    // Given one idle child and one poisoned child on a connection
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const idle = await connection.openSession(createRuntimeScope());
    const poisoned = await connection.openSession(createRuntimeScope());
    backend.enqueue({ kind: "unknown-before" });
    await poisoned.applyChangeSet(createRuntimeChangeSet(CHANGE_SET_IDS.first));

    // When the connection closes without explicit child closes
    await connection.close();

    // Then both children are closed and repeated close is idempotent
    await expectConnectorErrorCode(
      () => idle.bundles.get("bundle-a"),
      "SESSION_CLOSED",
    );
    await expectConnectorErrorCode(
      () =>
        poisoned.applyChangeSet(createRuntimeChangeSet(CHANGE_SET_IDS.first)),
      "SESSION_CLOSED",
    );
    await expect(connection.close()).resolves.toBeUndefined();
  });

  it("disposes owned resources once and borrowed resources never", async () => {
    // Given owned and borrowed connections
    let ownedDisposals = 0;
    const owned = createSubject<MutableScopeFixture["context"]>({
      dispose: async () => {
        ownedDisposals += 1;
      },
    });
    const borrowed = createSubject<MutableScopeFixture["context"]>();

    // When each connection is closed repeatedly and concurrently
    await Promise.all([
      owned.connection.close(),
      owned.connection.close(),
      borrowed.connection.close(),
      borrowed.connection.close(),
    ]);

    // Then ownership alone controls disposal count
    expect(ownedDisposals).toBe(1);
    await expectConnectorErrorCode(
      () => owned.connection.openSession(createRuntimeScope()),
      "CONNECTION_CLOSED",
    );
    await expectConnectorErrorCode(
      () => borrowed.connection.openSession(createRuntimeScope()),
      "CONNECTION_CLOSED",
    );
  });

  it("makes close win new opens and commits while preserving active commit A", async () => {
    // Given an active commit A and an owned disposer held in the closing phase
    const disposalRelease = new RuntimeDeferred<void>();
    const { backend, connection } = createSubject<
      MutableScopeFixture["context"]
    >({
      dispose: async () => await disposalRelease.promise,
    });
    const session = await connection.openSession(createRuntimeScope());
    const entered = backend.holdNextCommit();
    const commitA = session.applyChangeSet(
      createRuntimeChangeSet(CHANGE_SET_IDS.first),
    );
    await entered;

    // When connection close races with open and commit B
    const close = connection.close();
    await expectConnectorErrorCode(
      () => connection.openSession(createRuntimeScope()),
      "CONNECTION_CLOSING",
    );
    await expectConnectorErrorCode(
      () =>
        session.applyChangeSet(createRuntimeChangeSet(CHANGE_SET_IDS.second)),
      "SESSION_CLOSING",
    );

    // Then A finishes, close waits for disposal, and all later use is closed
    backend.releaseCommit();
    await expect(commitA).resolves.toMatchObject({ outcome: "committed" });
    disposalRelease.resolve();
    await close;
    await expectConnectorErrorCode(
      () => connection.openSession(createRuntimeScope()),
      "CONNECTION_CLOSED",
    );
    await expectConnectorErrorCode(
      () => session.bundles.channels(),
      "SESSION_CLOSED",
    );
  });
});
