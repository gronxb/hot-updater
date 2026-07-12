import { describe, expect, it } from "vitest";

import { expectConnectorErrorCode } from "./sessionRuntime.testAssertions";
import {
  CHANGE_SET_IDS,
  createRuntimeBundle,
  createRuntimeChangeSet,
  createRuntimeScope,
} from "./sessionRuntime.testFixtures";
import { setupRuntimeTestHarness } from "./sessionRuntime.testHarness";
import type { MutableScopeFixture } from "./sessionRuntime.testTypes";

const applyUntypedChangeSet = (
  session: object,
  changeSet: unknown,
): Promise<unknown> =>
  Reflect.apply(Reflect.get(session, "applyChangeSet"), session, [changeSet]);

const descriptorCases = (): readonly {
  readonly label: string;
  readonly create: (observeGetter: () => void) => unknown;
}[] => [
  {
    label: "an accessor on the root",
    create: (observeGetter) => {
      const changeSet = createRuntimeChangeSet(CHANGE_SET_IDS.first);
      Object.defineProperty(changeSet, "id", {
        configurable: true,
        enumerable: true,
        get: () => {
          observeGetter();
          return CHANGE_SET_IDS.first;
        },
      });
      return changeSet;
    },
  },
  {
    label: "a nested accessor",
    create: (observeGetter) => {
      const bundle = createRuntimeBundle("bundle-a");
      Object.defineProperty(bundle, "message", {
        configurable: true,
        enumerable: true,
        get: () => {
          observeGetter();
          return "bundle-a";
        },
      });
      return {
        id: CHANGE_SET_IDS.first,
        changes: [
          { type: "put", value: bundle, precondition: { state: "absent" } },
        ],
      };
    },
  },
  {
    label: "a non-enumerable property",
    create: () => {
      const changeSet = createRuntimeChangeSet(CHANGE_SET_IDS.first);
      Object.defineProperty(changeSet, "hidden", {
        enumerable: false,
        value: true,
      });
      return changeSet;
    },
  },
  {
    label: "a symbol property",
    create: () => {
      const changeSet = createRuntimeChangeSet(CHANGE_SET_IDS.first);
      Reflect.set(changeSet, Symbol("hidden"), true);
      return changeSet;
    },
  },
  {
    label: "an inherited shape",
    create: () => Object.create(createRuntimeChangeSet(CHANGE_SET_IDS.first)),
  },
  {
    label: "a sparse changes array",
    create: () => {
      const changeSet = createRuntimeChangeSet(CHANGE_SET_IDS.first);
      Reflect.deleteProperty(changeSet.changes, "0");
      return changeSet;
    },
  },
  {
    label: "a cycle",
    create: () => {
      const changeSet = createRuntimeChangeSet(CHANGE_SET_IDS.first);
      Reflect.set(changeSet, "self", changeSet);
      return changeSet;
    },
  },
  {
    label: "a present undefined value",
    create: () => ({
      ...createRuntimeChangeSet(CHANGE_SET_IDS.first),
      unexpected: undefined,
    }),
  },
];

describe("database-v2 untyped change-set boundary", () => {
  const createSubject = setupRuntimeTestHarness();

  it("rejects malformed object shapes before backend I/O", async () => {
    // Given values that violate the runtime change-set grammar
    const malformed: readonly unknown[] = [
      null,
      7,
      {},
      { id: 7, changes: [] },
      { id: CHANGE_SET_IDS.first, changes: null },
      { id: CHANGE_SET_IDS.first, changes: [null] },
      {
        id: CHANGE_SET_IDS.first,
        changes: [
          {
            type: "merge",
            value: createRuntimeBundle("bundle-a"),
            precondition: { state: "absent" },
          },
        ],
      },
      {
        id: CHANGE_SET_IDS.first,
        changes: [
          { type: "put", value: null, precondition: { state: "absent" } },
        ],
      },
      {
        id: CHANGE_SET_IDS.first,
        changes: [{ type: "delete", id: "bundle-a", precondition: null }],
      },
      {
        id: CHANGE_SET_IDS.first,
        changes: [
          {
            type: "delete",
            id: "bundle-a",
            precondition: { state: "revision", revision: 3 },
          },
        ],
      },
    ];

    // When each value crosses the public typed boundary at runtime
    for (const value of malformed) {
      const { backend, connection } =
        createSubject<MutableScopeFixture["context"]>();
      const session = await connection.openSession(createRuntimeScope());
      await expectConnectorErrorCode(
        () => applyUntypedChangeSet(session, value),
        "INVALID_CHANGE_SET",
      );

      // Then the malformed value never reaches a backend
      expect(backend.commitAttempts).toBe(0);
    }
  });

  for (const descriptorCase of descriptorCases()) {
    it(`rejects ${descriptorCase.label} without observing it`, async () => {
      // Given a forbidden descriptor or graph shape
      const { backend, connection } =
        createSubject<MutableScopeFixture["context"]>();
      const session = await connection.openSession(createRuntimeScope());
      let getterCalls = 0;
      const changeSet = descriptorCase.create(() => {
        getterCalls += 1;
      });

      // When the value crosses the public typed boundary at runtime
      await expectConnectorErrorCode(
        () => applyUntypedChangeSet(session, changeSet),
        "INVALID_CHANGE_SET",
      );

      // Then validation has no accessor or backend side effects
      expect(getterCalls).toBe(0);
      expect(backend.commitAttempts).toBe(0);
    });
  }
});
