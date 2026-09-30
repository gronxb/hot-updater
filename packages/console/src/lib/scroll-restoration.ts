import type { AnyRouter, ParsedLocation } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /**
     * The route's scroll-restoration key for a location; without one, each
     * history entry keeps its own scroll position.
     */
    readonly scrollRestorationKey?: (location: ParsedLocation) => string;
  }
}

/** A location's scroll-restoration key: its route's own, else its history entry's. */
export const routeScrollRestorationKey = (
  router: Pick<AnyRouter, "getMatchedRoutes">,
  location: ParsedLocation,
): string => {
  const { foundRoute } = router.getMatchedRoutes(location.pathname);
  const routeKey = foundRoute?.options.staticData?.scrollRestorationKey;
  return routeKey?.(location) ?? location.state.__TSR_key!;
};
