import { createDatabaseConnectionRuntimeV2 } from "./sessionRuntime";
import type { TestConnectionRuntimeFactoryV2 } from "./sessionRuntime.testTypes";

export const loadConnectionRuntimeFactory =
  async (): Promise<TestConnectionRuntimeFactoryV2> =>
    createDatabaseConnectionRuntimeV2;
