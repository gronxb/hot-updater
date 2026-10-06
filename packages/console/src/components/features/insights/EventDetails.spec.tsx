import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("shows the original unknown error and exposes its stack without inventing a category", () => {
    const message =
      "Unexpected catalog response: <html>upstream unavailable</html>";
    const stack = `Error: ${message}\n    at checkForUpdate (app.js:42:1)`;
    const view = render(
      <EventTypeDetails
        event={{
          type: "UPDATE_FAILED",
          failure: {
            stage: "check",
            reason: "unknown",
            resource: "catalog",
            errorMessage: message,
            errorStack: stack,
          },
        }}
      />,
    );
    expect(
      screen.getByText(`Update check failed: ${message} · catalog`),
    ).toBeDefined();
    expect(screen.queryByText(/Unknown reason/)).toBeNull();
    const disclosure = screen.getByText("Stack trace").closest("details")!;
    expect(disclosure.open).toBe(false);
    fireEvent.click(screen.getByText("Stack trace"));
    expect(disclosure.open).toBe(true);
    expect(disclosure.querySelector("pre")?.textContent).toBe(stack);
    view.rerender(
      <EventTypeDetails
        event={{
          type: "UPDATE_FAILED",
          failure: {
            stage: "check",
            reason: "unknown",
            resource: "catalog",
          },
        }}
      />,
    );
    expect(
      screen.getByText(
        "Update check failed: The client did not report a detailed cause · catalog",
      ),
    ).toBeDefined();
    expect(screen.queryByText("Stack trace")).toBeNull();
  });

  it("opens a server response as literal text and copies its stored body with context", async () => {
    const body =
      '<html><script>alert("failure")</script>Upstream unavailable</html>';
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(
      <EventTypeDetails
        event={{
          type: "UNCHANGED",
          platform: "ios",
          appVersion: "1.6.0",
          sdkVersion: "1.0.0-rc.29",
          channel: "production",
          installId: "device-1",
          httpResponse: {
            resource: "catalog",
            path: "/release-catalogs/app-version/ios/production/1.6.0",
            status: 503,
            body,
            bodyTruncated: true,
            receivedAtMs: Date.UTC(2026, 9, 3),
          },
        }}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "View catalog response: HTTP 503" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "HTTP response" });
    expect(dialog.querySelector("pre")?.textContent).toBe(body);
    expect(dialog.querySelector("script")).toBeNull();
    expect(within(dialog).getByText(/Truncated to the 4 KiB/)).toBeDefined();
    expect(within(dialog).getByText("iOS 1.6.0")).toBeDefined();
    expect(within(dialog).getByText("device-1")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy body" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(body));
    vi.unstubAllGlobals();
  });

  it.each([
    { status: 200, body: '{"releases":[]}', label: "Success", empty: null },
    {
      status: 304,
      body: "",
      label: "Not modified",
      empty: "Empty response body",
    },
    {
      status: 502,
      body: null,
      label: "Server error",
      empty: "Response body unavailable",
    },
  ])(
    "distinguishes HTTP $status and its body availability",
    async ({ status, body, label, empty }) => {
      render(
        <EventTypeDetails
          event={{
            type: "UNCHANGED",
            httpResponse: {
              resource: "catalog",
              path: "/catalog",
              status,
              body,
              bodyTruncated: false,
              receivedAtMs: Date.UTC(2026, 9, 3),
            },
          }}
        />,
      );
      expect(screen.getByText(`HTTP ${status}`).className).toContain(
        status >= 400 ? "bg-destructive" : "bg-secondary",
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: `View catalog response: HTTP ${status}`,
        }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "HTTP response",
      });
      expect(
        within(dialog).getByText(
          new RegExp(`Catalog · HTTP ${status} · ${label}`),
        ),
      ).toBeDefined();
      expect(within(dialog).getByText(/Response received/)).toBeDefined();
      if (empty) {
        expect(within(dialog).getByText(empty)).toBeDefined();
        expect(
          within(dialog)
            .getByRole("button", { name: "Copy body" })
            .hasAttribute("disabled"),
        ).toBe(true);
      } else {
        expect(dialog.querySelector("pre")?.textContent).toBe(body);
      }
    },
  );

  it("notes how a download arrived", () => {
    render(
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
