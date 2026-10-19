import { createMiddleware } from "@tanstack/react-start";

/**
 * Refuses a caller the console does not authorize before a server function
 * reads its input. TanStack Start runs a function's middleware before the
 * function's own validator, so an anonymous or unlisted caller gets the access
 * check's 401 or 403, never an input error, whatever it sends. Every server
 * function except the sign-in reads in `auth-rpc.ts` uses it, and
 * `console-access.spec.ts` checks that.
 */
export const consoleAccess = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const [{ getRequest }, { requireConsoleAccess }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./server/auth.server"),
    ]);
    await requireConsoleAccess(getRequest());
    return next();
  },
);
