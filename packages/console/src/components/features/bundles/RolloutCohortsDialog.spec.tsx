import {
  getNumericCohortRolloutPosition,
  NUMERIC_COHORT_SIZE,
} from "@hot-updater/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RolloutCohortsDialog } from "./RolloutCohortsDialog";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

afterEach(cleanup);

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
    expect(
      screen
        .getByText("Additional cohorts")
        .compareDocumentPosition(screen.getByText("Numeric cohorts")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders every numeric cohort for a full rollout", () => {
    render(
      <RolloutCohortsDialog releaseId="release-1" rolloutCohortCount={1_000} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview cohorts" }));

    const included = screen.getByRole("list", {
      name: "Included numeric cohorts",
    });
    expect(within(included).getAllByRole("listitem")).toHaveLength(1_000);
    expect(within(included).getByText("1")).toBeDefined();
    expect(within(included).getByText("1000")).toBeDefined();
    expect(
      screen.queryByText("All 1000 numeric cohorts are included."),
    ).toBeNull();
  });
});
