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

  it("labels a completed download with separate running and pending bundles", () => {
    render(
      <>
        <EventTypeDetails event={{ type: "UPDATE_DOWNLOADED" }} />
        <EventBundleTransition
          event={{
            type: "UPDATE_DOWNLOADED",
            fromBundleId: "file-a",
            toBundleId: "file-b",
          }}
        />
      </>,
    );
    expect(screen.getByText("Downloaded")).toBeDefined();
    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByText("Pending")).toBeDefined();
    expect(screen.getByText(/Waiting for the app to restart/)).toBeDefined();
  });

  it("shows no change without implying a file transition", () => {
    const type = "UNCHANGED";
    render(
      <>
        <EventTypeDetails event={{ type }} />
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
      screen.getByText("No download or apply was reported at this point."),
    ).toBeDefined();
    expect(screen.getByText("Current")).toBeDefined();
    expect(screen.queryByText("From")).toBeNull();
    expect(screen.queryByText("To")).toBeNull();
    expect(screen.queryByTitle(type)).toBeNull();
  });

  it("says where and why an update failed, and names no target for a failed check", () => {
    const view = render(
      <>
        <EventTypeDetails
          event={{
            type: "UPDATE_FAILED",
            failure: {
              stage: "download",
              reason: "http",
              httpStatus: 403,
              originCode: "ExpiredToken",
            },
          }}
        />
        <EventBundleTransition
          event={{
            type: "UPDATE_FAILED",
            fromBundleId: "file-a",
            toBundleId: "file-b",
            failure: { stage: "download", reason: "http" },
          }}
        />
      </>,
    );
    expect(screen.getByText("Update failed").className).toContain(
      "bg-destructive",
    );
    expect(
      screen.getByText("Download failed: HTTP error · HTTP 403 · ExpiredToken"),
    ).toBeDefined();
    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByText("Target")).toBeDefined();

    view.rerender(
      <EventBundleTransition
        event={{
          type: "UPDATE_FAILED",
          fromBundleId: "file-a",
          toBundleId: "file-a",
          failure: { stage: "check", reason: "invalid_response" },
        }}
      />,
    );
    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.queryByText("Target")).toBeNull();
  });

  it("notes how a download arrived and why a crashed process exited", () => {
    const view = render(
      <EventTypeDetails
        event={{
          type: "UPDATE_DOWNLOADED",
          delivery: "archive",
          patchFallback: true,
        }}
      />,
    );
    expect(
      screen.getByText("The patch failed. The full archive was downloaded."),
    ).toBeDefined();

    view.rerender(
      <EventTypeDetails
        event={{ type: "RECOVERED", previousProcessExit: "ANR" }}
      />,
    );
    expect(
      screen.getByText("The crashed process exited with ANR."),
    ).toBeDefined();
  });

  it("uses distinct product labels for event meaning", () => {
    const view = render(
      <EventTypeDetails event={{ type: "UPDATE_APPLIED" }} />,
    );
    expect(screen.getByText("Update applied")).toBeDefined();
    expect(screen.getByText("Update applied").className).toContain(
      "text-success",
    );

    view.rerender(<EventTypeDetails event={{ type: "RECOVERED" }} />);
    expect(screen.getByText("Recovered")).toBeDefined();
    expect(screen.getByText("Recovered").className).toContain("text-warning");

    view.rerender(<EventTypeDetails event={{ type: "UNCHANGED" }} />);
    expect(screen.getByText("No change")).toBeDefined();
    expect(
      screen.getByText("No download or apply was reported at this point."),
    ).toBeDefined();
    expect(screen.getByText("No change").className).toContain("bg-secondary");
  });
});
