import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

export const getConsoleAccessRpc = createServerFn({ method: "GET" }).handler(
  async () => {
    const { getConsoleAccess } = await import("./server/auth.server");
    return getConsoleAccess(getRequest());
  },
);

export const getConsoleAuthProvidersRpc = createServerFn({
  method: "GET",
}).handler(async () => {
  const { getConsoleAuthProviders } = await import("./server/auth.server");
  return getConsoleAuthProviders(getRequest());
});
