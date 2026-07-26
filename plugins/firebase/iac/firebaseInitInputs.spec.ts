import { describe, expect, it } from "vitest";

import {
  assertFirebaseNonInteractiveInputs,
  resolveFirebaseInitInputs,
} from "./firebaseInitInputs";

describe("Firebase non-interactive init inputs", () => {
  it("reports project and region together", () => {
    const inputs = resolveFirebaseInitInputs({});

    expect(() => assertFirebaseNonInteractiveInputs(inputs, true)).toThrow(
      expect.objectContaining({
        missingInputs: [
          "HOT_UPDATER_FIREBASE_PROJECT_ID",
          "HOT_UPDATER_FIREBASE_REGION",
        ],
      }),
    );
  });
});
