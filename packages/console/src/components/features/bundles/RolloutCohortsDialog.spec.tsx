import {
  getNumericCohortRolloutPosition,
  NUMERIC_COHORT_SIZE,
} from "@hot-updater/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RolloutCohortsDialog } from "./RolloutCohortsDialog";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

describe("RolloutCohortsDialog", () => {
  it("previews the cohorts selected by the Release identity", () => {
    const releaseId = "0195a408-8f13-7d9b-8df4-123456789abc";
    const rolloutCohorts = Array.from(
      { length: NUMERIC_COHORT_SIZE },
      (_, index) => index + 1,
    ).filter(
      (cohortValue) =>
        getNumericCohortRolloutPosition(releaseId, cohortValue) < 100,
    );

    render(
      <RolloutCohortsDialog
        releaseId={releaseId}
        rolloutCohortCount={100}
        targetCohorts={["qa-group"]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview cohorts" }));

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Selected cohorts")).toBeDefined();
    expect(screen.getByText(/^100$/)).toBeDefined();
    expect(
      screen.getByText(/10\.0% includes 100 of 1000 numeric cohorts\./),
    ).toBeDefined();
    expect(screen.getByText(String(rolloutCohorts[0]))).toBeDefined();
    expect(screen.getByText("qa-group")).toBeDefined();
  });

  it("matches main by hiding the preview outside gradual rollout", () => {
    const { rerender } = render(
      <RolloutCohortsDialog releaseId="release-1" rolloutCohortCount={1_000} />,
    );

    expect(
      screen.queryByRole("button", { name: "Preview cohorts" }),
    ).toBeNull();

    rerender(
      <RolloutCohortsDialog releaseId="release-1" rolloutCohortCount={0} />,
    );

    expect(
      screen.queryByRole("button", { name: "Preview cohorts" }),
    ).toBeNull();
  });
});
