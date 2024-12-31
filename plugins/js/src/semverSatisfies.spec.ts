import { setupSemverSatisfiesTestSuite } from "@hot-updater/core/test-utils";
import { describe } from "vitest";
import { semverSatisfies } from "./semverSatisfies";

describe("semverSatisfies", () => {
  setupSemverSatisfiesTestSuite({ semverSatisfies });
});
