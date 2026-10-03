import type { ParsedLocation } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import {
  installationsScrollRestorationKey,
  validateInstallationsSearch,
} from "./-installations-search";

describe("validateInstallationsSearch", () => {
  it("preserves opaque cursors, stable event cutoffs, and the event range", () => {
    expect(
      validateInstallationsSearch({
        eventsBefore: 100,
        eventsCursor: "events-2",
        eventsRange: "30d",
        historyBefore: 200,
        historyCursor: "history-2",
        installId: "install-1",
        query: "user-1",
        searchCursor: "search-2",
      }),
    ).toEqual({
      eventsBefore: 100,
      eventsCursor: "events-2",
      eventsRange: "30d",
      historyBefore: 200,
      historyCursor: "history-2",
      installId: "install-1",
      query: "user-1",
      searchCursor: "search-2",
    });
  });

  it("drops malformed pagination state instead of forwarding it", () => {
    expect(
      validateInstallationsSearch({
        eventsBefore: -1,
        eventsCursor: "",
        eventsRange: "1y",
        historyBefore: 1.5,
        historyCursor: 2,
        searchCursor: false,
      }),
    ).toEqual({
      eventsBefore: undefined,
      eventsCursor: undefined,
      eventsRange: undefined,
      historyBefore: undefined,
      historyCursor: undefined,
      installId: undefined,
      query: undefined,
      searchCursor: undefined,
    });
  });

  it("does not serialize previous cursor stacks into the URL", () => {
    expect(
      validateInstallationsSearch({
        eventsBack: ["event-1", "event-2"],
        historyBack: ["history-1"],
        searchBack: ["search-1"],
      }),
    ).toEqual({
      eventsBefore: undefined,
      eventsCursor: undefined,
      eventsRange: undefined,
      historyBefore: undefined,
      historyCursor: undefined,
      installId: undefined,
      query: undefined,
      searchCursor: undefined,
    });
  });
});

describe("installationsScrollRestorationKey", () => {
  const at = (search: Record<string, unknown>) =>
    ({
      pathname: "/installations",
      search,
      state: { __TSR_key: "history-entry" },
    }) as unknown as ParsedLocation;

  it("shares one scroll position per page of the event list", () => {
    expect(installationsScrollRestorationKey(at({}))).toBe(
      "/installations?eventsBefore=new&eventsRange=7d&eventsCursor=first",
    );
    expect(
      installationsScrollRestorationKey(
        at({ eventsBefore: 100, eventsRange: "30d", eventsCursor: "events-2" }),
      ),
    ).toBe(
      "/installations?eventsBefore=100&eventsRange=30d&eventsCursor=events-2",
    );
  });

  it("keeps each history entry's position for a lookup", () => {
    expect(installationsScrollRestorationKey(at({ query: "user-1" }))).toBe(
      "history-entry",
    );
    expect(
      installationsScrollRestorationKey(at({ installId: "install-1" })),
    ).toBe("history-entry");
  });
});
