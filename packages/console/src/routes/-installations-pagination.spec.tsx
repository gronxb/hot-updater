import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/sidebar", () => ({ SidebarTrigger: () => null }));

vi.mock("@/lib/insights-api", () => {
  const installation = {
    installId: "install-1",
    userId: "user-1",
    username: null,
    appVersion: "1.5.0",
    channel: "production",
    platform: "ios",
    receivedAtMs: 100,
    lastKnownBundleId: "bundle-1",
    latestStatus: "UNCHANGED",
  };
  const page = ({ cursor }: { cursor?: string }) => ({
    data: {
      data: [
        {
          ...installation,
          id: cursor ?? "first",
          type: "UNCHANGED",
          toBundleId: "bundle-1",
          fromBundleId: null,
        },
      ],
      nextCursor:
        cursor === "third" ? null : cursor === "second" ? "third" : "second",
      beforeReceivedAtMs: 100,
    },
    error: null,
    isFetching: false,
    isLoading: false,
  });
  return {
    useInsightsEventsQuery: page,
    useInsightsInstallationsQuery: page,
    useInsightsInstallationEventsQuery: page,
    useInsightsInstallationQuery: () => ({
      data: installation,
      error: null,
      isLoading: false,
    }),
  };
});

import { Route } from "./installations";

async function mountPage() {
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/installations",
    component: Route.options.component,
    validateSearch: Route.options.validateSearch,
  });
  const history = createBrowserHistory();
  const router = createRouter({
    history,
    routeTree: root.addChildren([route]),
  });
  const view = render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Insights" });
  return () => {
    view.unmount();
    history.destroy();
  };
}

const pagination = (label: string) =>
  within(screen.getByRole("navigation", { name: `${label} pagination` }));
async function expectPage(label: string, number: number) {
  await waitFor(() =>
    expect(
      pagination(label).getByText(new RegExp(`Page ${number} ·`)),
    ).toBeDefined(),
  );
  expect(
    (
      pagination(label).getByRole("button", {
        name: "Previous",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(number === 1);
}
const next = (label: string) =>
  fireEvent.click(pagination(label).getByRole("button", { name: "Next" }));
const previous = (label: string) =>
  fireEvent.click(pagination(label).getByRole("button", { name: "Previous" }));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("Insights pagination across browser reloads", () => {
  it.each([
    ["All events", "eventsCursor", ""],
    [
      "Installation results",
      "searchCursor",
      "&query=user-1&installId=install-1&historyBefore=200",
    ],
    [
      "Installation history",
      "historyCursor",
      "&installId=install-1&historyBefore=200",
    ],
  ])(
    "restores %s page 3 and both previous cursors",
    async (label, cursorKey, query) => {
      window.history.replaceState(
        null,
        "",
        `/installations?eventsBefore=100${query}`,
      );
      let unmount = await mountPage();
      next(label);
      await expectPage(label, 2);
      next(label);
      await expectPage(label, 3);

      // Recreate the router and component, preserving only browser history.
      unmount();
      unmount = await mountPage();
      await expectPage(label, 3);
      previous(label);
      await expectPage(label, 2);
      expect(new URLSearchParams(window.location.search).get(cursorKey)).toBe(
        "second",
      );
      previous(label);
      await expectPage(label, 1);
      expect(new URLSearchParams(window.location.search).has(cursorKey)).toBe(
        false,
      );
      expect(
        new URLSearchParams(window.location.search).get("eventsBefore"),
      ).toBe("100");
      unmount();
    },
  );

  it("keeps the event page when returning from reloaded installation details, then resets on Refresh", async () => {
    window.history.replaceState(null, "", "/installations?eventsBefore=100");
    let unmount = await mountPage();
    next("All events");
    await expectPage("All events", 2);
    fireEvent.click(
      screen.getAllByRole("link", {
        name: "View history for user-1 (install-1)",
      })[0],
    );
    await expectPage("Installation history", 1);
    next("Installation history");
    await expectPage("Installation history", 2);

    unmount();
    unmount = await mountPage();
    await expectPage("Installation history", 2);
    fireEvent.click(screen.getByRole("button", { name: "Back to all events" }));
    await expectPage("All events", 2);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await expectPage("All events", 1);
    unmount();
    unmount = await mountPage();
    await expectPage("All events", 1);
    unmount();
  });
});
