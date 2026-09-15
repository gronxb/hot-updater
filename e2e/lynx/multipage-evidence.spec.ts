import { describe, expect, it } from "vitest";

import type { GenerationEventsSnapshot } from "../../examples/lynx/src/e2eApp/generationEvents";
import {
  assertManagedDetailClosed,
  assertManagedDetailPending,
  assertManagedDetailOpened,
  assertManagedInstallRejected,
  assertManagedMainPage,
  assertManagedPageTerminal,
  assertManagedVerifiedFatalDetail,
} from "./multipage-evidence";

const main = {
  runtimeId: "lynx-runtime",
  processId: "712",
  generationId: "generation-a",
  contextId: "context-main-a",
  attemptId: "attempt-a",
  pageAttemptId: null,
  bundleId: "bundle-a",
  releaseId: "release-a",
  pageEntry: "main.lynx.bundle",
};
const detail = {
  ...main,
  contextId: "context-detail-a",
  pageAttemptId: "page-attempt-a",
  pageEntry: "detail.lynx.bundle",
};
const event = (
  sequence: string,
  name: string,
  details: Record<string, unknown>,
) => ({ sequence, name, details });

const snapshot = (
  events: GenerationEventsSnapshot["events"],
): GenerationEventsSnapshot => ({
  schemaVersion: 1,
  oldestSequence: events.at(0)?.sequence ?? null,
  latestSequence: events.at(-1)?.sequence ?? null,
  truncated: false,
  events,
});

describe("managed Lynx multi-page evidence", () => {
  it("proves a real iOS detail page, its admission, params, and JS close", () => {
    const initial = snapshot([
      event("1", "generationStarted", {
        ...main,
        contextIds: [main.contextId],
        primaryContextId: main.contextId,
        orderedPageEntries: ["main.lynx.bundle"],
        topPageEntry: "main.lynx.bundle",
      }),
      event("2", "firstContent", main),
      event("3", "jsReady", { ...main, confirmation: { status: "CONFIRMED" } }),
    ]);
    const mainIdentity = assertManagedMainPage(initial, {
      bundleId: main.bundleId,
      releaseId: main.releaseId,
    });
    const opened = snapshot([
      event("4", "resourceLoaded", {
        ...detail,
        path: "detail.lynx.bundle",
        sha256: "a".repeat(64),
      }),
      event("5", "pageOpened", {
        ...detail,
        nativePageClass: "Sparkling.SPKViewController",
        sourceContextId: main.contextId,
        parameters: { value: "a+b", title: "Second Page" },
        orderedPageEntries: ["main.lynx.bundle", "detail.lynx.bundle"],
        topPageEntry: "detail.lynx.bundle",
        outcome: "opened",
      }),
      event("6", "firstContent", detail),
      event("7", "pageAttemptTerminal", {
        ...detail,
        nativePageClass: "Sparkling.SPKViewController",
        sourceContextId: main.contextId,
        orderedPageEntries: ["main.lynx.bundle", "detail.lynx.bundle"],
        topPageEntry: "detail.lynx.bundle",
        terminal: "admitted",
      }),
      event("8", "pageAdmitted", {
        ...detail,
        confirmation: { status: "PAGE_ADMITTED" },
      }),
    ]);
    const detailIdentity = assertManagedDetailOpened(opened, {
      platform: "ios",
      main: mainIdentity,
      detailSha256: "a".repeat(64),
      expectedParameters: { title: "Second Page", value: "a+b" },
    });
    assertManagedDetailClosed(
      snapshot([
        event("9", "pageClosed", {
          ...detail,
          orderedPageEntries: ["main.lynx.bundle"],
          topPageEntry: "main.lynx.bundle",
          outcome: "closed",
        }),
      ]),
      { platform: "ios", detail: detailIdentity, cause: "close" },
    );
  });

  it("rejects duplicate-main and mixed-Release observations", () => {
    expect(() =>
      assertManagedMainPage(
        snapshot([
          event("1", "generationStarted", {
            ...main,
            contextIds: [main.contextId, "duplicate-main"],
            primaryContextId: main.contextId,
            orderedPageEntries: ["main.lynx.bundle"],
            topPageEntry: "main.lynx.bundle",
          }),
          event("2", "firstContent", main),
          event("3", "jsReady", main),
        ]),
        { bundleId: main.bundleId, releaseId: main.releaseId },
      ),
    ).toThrow("one real main page");

    expect(() =>
      assertManagedDetailOpened(
        snapshot([
          event("4", "routeOpened", {
            ...detail,
            releaseId: "release-other",
            nativePageClass:
              "com.hotupdater.lynx.sparkling.HotUpdaterSparklingPageActivity",
            sourceContextId: main.contextId,
            pageParameters: { title: "Second Page" },
            orderedPageEntries: ["main.lynx.bundle", "detail.lynx.bundle"],
            topPageEntry: "detail.lynx.bundle",
            outcome: "opened",
          }),
        ]),
        {
          platform: "android",
          main,
          detailSha256: "a".repeat(64),
        },
      ),
    ).toThrow("distinct context in the running Release");
  });

  it("accepts Android's durable admission callback order", () => {
    expect(
      assertManagedDetailOpened(
        snapshot([
          event("4", "routeOpened", {
            ...detail,
            nativePageClass:
              "com.hotupdater.lynx.sparkling.HotUpdaterSparklingPageActivity",
            sourceContextId: main.contextId,
            pageParameters: { title: "Second Page" },
            orderedPageEntries: ["main.lynx.bundle", "detail.lynx.bundle"],
            topPageEntry: "detail.lynx.bundle",
            outcome: "opened",
          }),
          event("5", "resourceLoaded", {
            ...detail,
            path: "detail.lynx.bundle",
            sha256: "a".repeat(64),
          }),
          event("6", "firstContent", detail),
          event("7", "pageAdmitted", detail),
          event("8", "pageAttemptTerminal", {
            ...detail,
            nativePageClass:
              "com.hotupdater.lynx.sparkling.HotUpdaterSparklingPageActivity",
            sourceContextId: main.contextId,
            orderedPageEntries: ["main.lynx.bundle", "detail.lynx.bundle"],
            topPageEntry: "detail.lynx.bundle",
            terminal: "admitted",
          }),
        ]),
        { platform: "android", main },
      ),
    ).toMatchObject({ contextId: detail.contextId });
  });

  it("rejects any generation transition after an atomic install failure", () => {
    const before = snapshot([event("10", "jsReady", main)]);
    const rejected = { bundleId: "bundle-c", releaseId: "release-c" };
    expect(() =>
      assertManagedInstallRejected(
        before,
        snapshot([
          ...before.events,
          event("11", "generationStarted", { ...detail, ...rejected }),
        ]),
        { rejected, running: main },
      ),
    ).toThrow("started a native generation");
    expect(() =>
      assertManagedInstallRejected(before, before, {
        rejected,
        running: main,
      }),
    ).not.toThrow();
  });

  it("requires one authentic terminal for a pending managed detail attempt", () => {
    const pendingEvents = snapshot([
      event("20", "pageOpened", {
        ...detail,
        nativePageClass: "Sparkling.SPKViewController",
        sourceContextId: main.contextId,
        orderedPageEntries: ["main.lynx.bundle", "detail.lynx.bundle"],
        topPageEntry: "detail.lynx.bundle",
        outcome: "opened",
      }),
      event("21", "firstContent", detail),
    ]);
    const pending = assertManagedDetailPending(pendingEvents, {
      platform: "ios",
      main,
    });
    const completed = snapshot([
      ...pendingEvents.events,
      event("22", "pageAttemptTerminal", {
        ...detail,
        reason: "managedTransition",
        terminal: "authorized-cancel",
        transitionId: "transition-1",
      }),
    ]);
    expect(
      assertManagedPageTerminal(completed, pending, {
        reason: "managedTransition",
        terminal: "authorized-cancel",
        transitionId: "transition-1",
      }),
    ).toMatchObject({ sequence: "22" });
    expect(() =>
      assertManagedPageTerminal(
        snapshot([
          ...completed.events,
          event("23", "pageAttemptTerminal", {
            ...detail,
            terminal: "process-interruption",
          }),
        ]),
        pending,
        { terminal: "authorized-cancel" },
      ),
    ).toThrow("exactly one durable terminal");
  });

  it("requires real detail evaluation, resource, and first content before fatal classification", () => {
    const failed = snapshot([
      event("30", "generationWillEvaluate", detail),
      event("31", "resourceLoaded", {
        ...detail,
        path: "detail.lynx.bundle",
        sha256: "b".repeat(64),
      }),
      event("32", "firstContent", detail),
      event("33", "runtimeFailed", detail),
      event("34", "pageAttemptTerminal", {
        ...detail,
        nativePageClass: "Sparkling.SPKViewController",
        sourceContextId: main.contextId,
        orderedPageEntries: ["main.lynx.bundle", "detail.lynx.bundle"],
        topPageEntry: "detail.lynx.bundle",
        terminal: "verified-fatal",
      }),
      event("35", "generationFailed", detail),
    ]);
    expect(
      assertManagedVerifiedFatalDetail(
        failed,
        { bundleId: detail.bundleId, releaseId: detail.releaseId },
        "ios",
      ),
    ).toMatchObject({ pageAttemptId: detail.pageAttemptId });
    expect(() =>
      assertManagedVerifiedFatalDetail(
        snapshot(failed.events.filter((item) => item.name !== "firstContent")),
        { bundleId: detail.bundleId, releaseId: detail.releaseId },
        "ios",
      ),
    ).toThrow("firstContent");
  });
});
