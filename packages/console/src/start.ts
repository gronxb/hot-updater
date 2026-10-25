import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start";

/**
 * Server functions answer only their own console's pages: a request
 * another site sends, such as a form that posts to one, gets 403. TanStack
 * Start adds this check itself only while no `start.ts` exists, so it is
 * listed here, and `start.spec.ts` keeps it listed.
 */
const sameOriginServerFunctions = createCsrfMiddleware({
  filter: (context) => context.handlerType === "serverFn",
});

/**
 * The local console's lock, before any page, server function, or route:
 * this machine's `Host` only, changes from its own pages only, and the
 * run's session for every page, server function, and route. A hosted
 * console has none: its sign-in guards it.
 */
const localConsoleGuard = createMiddleware().server(
  async ({ request, next }) => {
    const { default: guard } =
      await import("virtual:hot-updater-console/request-guard");
    return (await guard?.(request)) ?? next();
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [sameOriginServerFunctions, localConsoleGuard],
}));
