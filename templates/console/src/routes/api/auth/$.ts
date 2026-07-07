import { createFileRoute } from "@tanstack/react-router";

import { getAuth } from "@/lib/server/auth-factory.server";

const handleAuthRequest = async ({ request }: { readonly request: Request }) =>
  getAuth().handler(request);

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: handleAuthRequest,
      POST: handleAuthRequest,
    },
  },
});
