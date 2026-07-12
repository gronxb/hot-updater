import { afterEach, beforeAll } from "vitest";

import type { DatabaseConnectionV2 } from "./connector";
import type { ScriptedRuntimeBackend } from "./sessionRuntime.testBackend";
import { setupRuntimeSubject } from "./sessionRuntime.testFixtures";
import { loadConnectionRuntimeFactory } from "./sessionRuntime.testLoader";
import type {
  TestConnectionRuntimeFactoryV2,
  TestConnectionRuntimeOptionsV2,
} from "./sessionRuntime.testTypes";

const missingFactory: TestConnectionRuntimeFactoryV2 = () => {
  throw new TypeError("database-v2 runtime factory has not loaded");
};

interface TrackedRuntimeSubject<TContext> {
  readonly backend: ScriptedRuntimeBackend;
  readonly connection: DatabaseConnectionV2<TContext>;
}

export const setupRuntimeTestHarness = () => {
  let factory = missingFactory;
  const subjects: TrackedRuntimeSubject<unknown>[] = [];

  beforeAll(async () => {
    factory = await loadConnectionRuntimeFactory();
  });

  afterEach(async () => {
    for (const subject of subjects.splice(0)) {
      subject.backend.releaseCommitIfHeld();
      await subject.connection.close();
    }
  });

  return <TContext>(
    options?: Omit<TestConnectionRuntimeOptionsV2, "backend" | "resource"> & {
      readonly dispose?: () => Promise<void>;
    },
  ): TrackedRuntimeSubject<TContext> => {
    const subject = setupRuntimeSubject<TContext>(factory, options);
    subjects.push(subject);
    return subject;
  };
};
