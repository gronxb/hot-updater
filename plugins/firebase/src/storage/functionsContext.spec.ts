import { describe, expect, it } from "vitest";

import { createFunctionsStorageContext } from "./functionsContext";

describe("createFunctionsStorageContext", () => {
  it("snapshots maps while preserving live binding identity", () => {
    // Given
    const credential = { getAccessToken: async () => ({ token: "a" }) };
    const environment = { PROJECT_ID: "project-a" };
    const bindings = { FIREBASE_CREDENTIAL: credential };

    // When
    const context = createFunctionsStorageContext({ environment, bindings });
    environment.PROJECT_ID = "project-b";
    bindings.FIREBASE_CREDENTIAL = {
      getAccessToken: async () => ({ token: "b" }),
    };

    // Then
    expect(context).toEqual({
      target: "functions",
      environment: { PROJECT_ID: "project-a" },
      bindings: { FIREBASE_CREDENTIAL: credential },
    });
    expect(context.bindings.FIREBASE_CREDENTIAL).toBe(credential);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.environment)).toBe(true);
    expect(Object.isFrozen(context.bindings)).toBe(true);
  });
});
