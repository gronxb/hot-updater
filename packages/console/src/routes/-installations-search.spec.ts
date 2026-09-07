import { describe, expect, it } from "vitest";

import { validateInstallationsSearch } from "./-installations-search";

describe("validateInstallationsSearch", () => {
  it("preserves opaque cursors and stable event cutoffs", () => {
    expect(
      validateInstallationsSearch({
        eventsBefore: 100,
        eventsCursor: "events-2",
        historyBefore: 200,
        historyCursor: "history-2",
        installId: "install-1",
        query: "user-1",
        searchCursor: "search-2",
      }),
    ).toEqual({
      eventsBefore: 100,
      eventsCursor: "events-2",
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
        historyBefore: 1.5,
        historyCursor: 2,
        searchCursor: false,
      }),
    ).toEqual({
      eventsBefore: undefined,
      eventsCursor: undefined,
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
      historyBefore: undefined,
      historyCursor: undefined,
      installId: undefined,
      query: undefined,
      searchCursor: undefined,
    });
  });
});
