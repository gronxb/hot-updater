import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InsightsExpiredState,
  InsightsFailedState,
  InsightsPreparingState,
  InsightsStaleNotice,
} from "./InsightsReadState";

describe("Insights read states", () => {
  afterEach(cleanup);

  it("distinguishes a durable preparation job from an empty result", () => {
    render(<InsightsPreparingState />);

    expect(screen.getByText("Preparing exact results")).toBeDefined();
    expect(
      screen.getByText(
        "This view will update when the durable preparation job finishes.",
      ),
    ).toBeDefined();
  });

  it("keeps the last complete publication visible while refreshing", () => {
    render(<InsightsStaleNotice asOfMs={Date.UTC(2026, 6, 18, 0, 0, 0)} />);

    expect(screen.getByText("Refreshing exact results")).toBeDefined();
    expect(
      screen.getByText(/Showing the last complete report from .* GMT[+-]/),
    ).toBeDefined();
  });

  it("explains that migration poison did not mutate the source event", () => {
    render(
      <InsightsFailedState
        failure={{ code: "migration-poison", jobId: "prepare-1" }}
      />,
    );

    expect(
      screen.getByText(
        "Insights preparation found an event that cannot be migrated safely. The source event was left unchanged.",
      ),
    ).toBeDefined();
  });

  it("restarts an expired publication only when requested", () => {
    const onRestart = vi.fn();
    render(<InsightsExpiredState onRestart={onRestart} />);

    expect(onRestart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    expect(onRestart).toHaveBeenCalledOnce();
  });
});
