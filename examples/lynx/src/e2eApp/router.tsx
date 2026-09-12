import { createMemoryHistory, createRouter } from "@tanstack/react-router";

import { SCREEN_PATHS, TEST_ID_TO_SCREEN } from "./e2eStack";
import { routeTree } from "./routeTree.gen";

const memoryHistory = createMemoryHistory({
  initialEntries: ["/e2e/ready"],
});

export const router = createRouter({
  routeTree,
  history: memoryHistory,
  isServer: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function navigateToTestId(testID: string): void {
  const screen = TEST_ID_TO_SCREEN[testID];
  if (!screen) return;
  void router.navigate({ to: `/${SCREEN_PATHS[screen]}` });
}
