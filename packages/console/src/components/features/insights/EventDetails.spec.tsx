import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  EventBundleTransition,
  EventTimestamp,
  EventTypeDetails,
} from "./EventDetails";

describe("Insights event details", () => {
  afterEach(cleanup);

  it("shows local time with its GMT offset and exact UTC detail", () => {
    const formatter = new Intl.DateTimeFormat("en", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: "Asia/Seoul",
      timeZoneName: "shortOffset",
      year: "numeric",
    });

    render(
      <EventTimestamp
        formatter={formatter}
        value={Date.UTC(2026, 6, 18, 0, 0, 0)}
      />,
    );

    expect(screen.getByText("2026/07/18 09:00:00 GMT+9")).toBeDefined();
    expect(screen.getByText("2026-07-18 00:00:00.000 UTC")).toBeDefined();
  });

  it("shows no change without implying a file transition", () => {
    const type = "UNCHANGED";
    render(
      <>
        <EventTypeDetails type={type} />
        <EventBundleTransition
          event={{
            type,
            fromBundleId: null,
            toBundleId: "same-file",
          }}
        />
      </>,
    );
    expect(screen.getByText("No change")).toBeDefined();
    expect(
      screen.getByText("The app continues using the same bundle files."),
    ).toBeDefined();
    expect(screen.getByText("Current")).toBeDefined();
    expect(screen.queryByText("From")).toBeNull();
    expect(screen.queryByText("To")).toBeNull();
    expect(screen.queryByTitle(type)).toBeNull();
  });

  it("uses distinct product labels for event meaning", () => {
    const view = render(<EventTypeDetails type="UPDATE_APPLIED" />);
    expect(screen.getByText("Update applied")).toBeDefined();
    expect(screen.getByText("Update applied").className).toContain(
      "text-success",
    );

    view.rerender(<EventTypeDetails type="RECOVERED" />);
    expect(screen.getByText("Rolled back")).toBeDefined();
    expect(screen.getByText("Rolled back").className).toContain("text-warning");

    view.rerender(<EventTypeDetails type="UNCHANGED" />);
    expect(screen.getByText("No change")).toBeDefined();
    expect(
      screen.getByText("The app continues using the same bundle files."),
    ).toBeDefined();
    expect(screen.getByText("No change").className).toContain("bg-secondary");
  });
});
