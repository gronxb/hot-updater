import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { InsightsErrorAlert } from "./InsightsErrorAlert";

describe("InsightsErrorAlert", () => {
  afterEach(cleanup);

  it("reads a server that stopped running insights() as setup, not a failure", () => {
    // How a server function's ConsoleFeatureUnavailableError reaches the page.
    const refused = Object.assign(
      new Error("The server runs without the insights() plugin."),
      { name: "ConsoleFeatureUnavailableError", feature: "insights" },
    );

    render(
      <InsightsErrorAlert error={refused} fallbackTitle="Events unavailable" />,
    );

    expect(screen.getByText("Insights not installed")).toBeDefined();
    expect(
      screen.getByText("The server runs without the insights() plugin."),
    ).toBeDefined();
    expect(screen.queryByText("Events unavailable")).toBeNull();
    expect(screen.getByRole("alert").getAttribute("class")).not.toContain(
      "destructive",
    );
  });

  it("reports any other failure under the fallback title", () => {
    render(
      <InsightsErrorAlert
        error={new Error("Offline")}
        fallbackTitle="Events unavailable"
      />,
    );

    expect(screen.getByText("Events unavailable")).toBeDefined();
    expect(screen.getByRole("alert").getAttribute("class")).toContain(
      "destructive",
    );
  });
});
