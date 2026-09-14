import { describe, expect, it } from "vitest";

import {
  assertNoManagedResourceEngineErrors,
  findManagedResourceEngineErrorCodes,
} from "./managed-resource-errors";

describe("managed Lynx resource engine errors", () => {
  it.each([301, 302])(
    "rejects engine code %s even after native confirmation",
    (code) => {
      const logs = [
        "HotUpdaterLynx: confirmed bundle=bundle-A release=null attempt=attempt-A",
        `HotUpdaterLynx: engine-error fatal=false code=${code} message=resource failed`,
      ].join("\n");

      expect(findManagedResourceEngineErrorCodes(logs)).toEqual([code]);
      expect(() => assertNoManagedResourceEngineErrors(logs)).toThrow(
        `Managed Lynx resources emitted engine errors: ${code}`,
      );
    },
  );

  it("accepts native confirmation without managed-resource engine errors", () => {
    expect(() =>
      assertNoManagedResourceEngineErrors(
        "HotUpdaterLynx: confirmed bundle=bundle-A release=null attempt=attempt-A",
      ),
    ).not.toThrow();
  });
});
