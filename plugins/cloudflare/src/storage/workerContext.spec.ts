import { describe, expect, it } from "vitest";

import { createWorkerStorageContext } from "./workerContext";

describe("createWorkerStorageContext", () => {
  it("preserves live binding identity in frozen request maps", () => {
    // Given
    const bucket = { writes: 0 };

    // When
    const context = createWorkerStorageContext({
      environment: { MODE: "test" },
      bindings: { BUCKET: bucket },
    });

    // Then
    expect(context.target).toBe("worker");
    expect(context.bindings.BUCKET).toBe(bucket);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.environment)).toBe(true);
    expect(Object.isFrozen(context.bindings)).toBe(true);
    expect(Object.isFrozen(bucket)).toBe(false);
  });
});
