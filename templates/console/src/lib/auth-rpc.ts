import { createServerFn } from "@tanstack/react-start";

export const getConsoleSessionState = createServerFn({
  method: "GET",
}).handler(async () => {
  const { getConsoleSession } = await import("./server/auth-guard.server.ts");
  const session = await getConsoleSession();

  return { authenticated: Boolean(session) };
});

export const ensureConsoleSession = createServerFn({ method: "GET" }).handler(
  async () => {
    const { requireConsoleSession } = await import(
      "./server/auth-guard.server.ts"
    );
    await requireConsoleSession();

    return { authenticated: true };
  },
);
