import {
  createRootRoute,
  createRoute,
  createRouter,
  type ParsedLocation,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { routeScrollRestorationKey } from "./scroll-restoration";

const rootRoute = createRootRoute();
const router = createRouter({
  routeTree: rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/" }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/events",
      staticData: {
        scrollRestorationKey: (location) =>
          `/events?page=${String(Reflect.get(location.search, "page") ?? 1)}`,
      },
    }),
  ]),
});

const at = (pathname: string, search: Record<string, unknown> = {}) =>
  ({
    pathname,
    search,
    state: { __TSR_key: `entry-of-${pathname}` },
  }) as unknown as ParsedLocation;

describe("routeScrollRestorationKey", () => {
  it("uses the key a route declares", () => {
    expect(routeScrollRestorationKey(router, at("/events", { page: 2 }))).toBe(
      "/events?page=2",
    );
  });

  it("keeps each history entry's key on a route that declares none", () => {
    expect(routeScrollRestorationKey(router, at("/"))).toBe("entry-of-/");
    expect(routeScrollRestorationKey(router, at("/missing"))).toBe(
      "entry-of-/missing",
    );
  });
});
