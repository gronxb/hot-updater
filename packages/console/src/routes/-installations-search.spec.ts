import { describe, expect, it } from "vitest";

import { validateInstallationsSearch } from "./-installations-search";

describe("validateInstallationsSearch", () => {
  it("preserves independent cursor histories and immutable event cutoffs", () => {
    expect(
      validateInstallationsSearch({
        query: "ada",
        installId: "install-1",
        eventsCursor: "events-next",
        eventsBack: ["events-first"],
        eventsBefore: 100,
        searchCursor: "search-next",
        searchBack: ["search-first"],
        searchPublicationId: "publication-1",
        historyCursor: "history-next",
        historyBack: ["history-first"],
        historyBefore: 90,
      }),
    ).toEqual({
      query: "ada",
      installId: "install-1",
      eventsCursor: "events-next",
      eventsBack: ["events-first"],
      eventsBefore: 100,
      searchCursor: "search-next",
      searchBack: ["search-first"],
      searchPublicationId: "publication-1",
      historyCursor: "history-next",
      historyBack: ["history-first"],
      historyBefore: 90,
    });
  });

  it("drops malformed cursors, stacks, and event cutoffs", () => {
    expect(
      validateInstallationsSearch({
        eventsCursor: "",
        eventsBack: ["first", 2],
        eventsBefore: -1,
        searchCursor: 2,
        searchBack: "first",
        historyCursor: null,
        historyBack: {},
        historyBefore: 1.5,
      }),
    ).toEqual({
      query: undefined,
      installId: undefined,
      eventsCursor: undefined,
      eventsBack: undefined,
      eventsBefore: undefined,
      searchCursor: undefined,
      searchBack: undefined,
      searchPublicationId: undefined,
      historyCursor: undefined,
      historyBack: undefined,
      historyBefore: undefined,
    });
  });
});
