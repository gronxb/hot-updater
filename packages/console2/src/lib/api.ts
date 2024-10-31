import { createTRPCProxyClient, httpBatchLink, loggerLink } from "@trpc/client";
import type { AppRouter } from "~/server/api/root";

const getBaseUrl = () => {
  return "http://localhost:3000";
};

// create the client, export it
export const api = createTRPCProxyClient<AppRouter>({
  links: [
    // will print out helpful logs when using client
    loggerLink(),
    // identifies what url will handle trpc requests
    httpBatchLink({ url: `${getBaseUrl()}/api/trpc` }),
  ],
});
