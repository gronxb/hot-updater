import {
  getNumericCohortRolloutPosition,
  NUMERIC_COHORT_SIZE,
} from "@hot-updater/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RolloutCohortsDialog } from "./RolloutCohortsDialog";

describe("RolloutCohortsDialog", () => {
  it("renders a trigger and shows the rolled out cohorts for partial rollout", () => {
    const bundleId = "0195a408-8f13-7d9b-8df4-123456789abc";
    const rolloutCohorts = Array.from(
      { length: NUMERIC_COHORT_SIZE },
      (_, index) => index + 1,
    ).filter(
      (cohortValue) =>
        getNumericCohortRolloutPosition(bundleId, cohortValue) < 100,
    );

    render(
      <RolloutCohortsDialog
        bundleId={bundleId}
        rolloutCohortCount={100}
        targetCohorts={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View Cohorts" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Selected Cohorts")).toBeTruthy();
    expect(screen.getByText(/^100$/)).toBeTruthy();
    expect(
      screen.getByText(
        /10\.0% rollout currently targets 100 of 1000 numeric cohorts\./,
      ),
    ).toBeTruthy();
    expect(screen.getByText(String(rolloutCohorts[0]))).toBeTruthy();
    expect(
      screen.getByText(String(rolloutCohorts[rolloutCohorts.length - 1])),
    ).toBeTruthy();
  });

  it("hides the trigger when rollout is full", () => {
    render(
      <RolloutCohortsDialog
        bundleId="0195a408-8f13-7d9b-8df4-123456789abc"
        rolloutCohortCount={1000}
        targetCohorts={[]}
      />,
    );

    expect(screen.queryByRole("button", { name: "View Cohorts" })).toBeNull();
  });

  it("hides the trigger when target cohorts override gradual rollout", () => {
    render(
      <RolloutCohortsDialog
        bundleId="0195a408-8f13-7d9b-8df4-123456789abc"
        rolloutCohortCount={100}
        targetCohorts={["qa-group"]}
      />,
    );

    expect(screen.queryByRole("button", { name: "View Cohorts" })).toBeNull();
  });
});
