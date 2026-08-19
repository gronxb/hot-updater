import { createFileRoute } from "@tanstack/react-router";

const handleAuthRequest = async ({
  request,
}: {
  readonly request: Request;
}) => {
  const { handleConsoleAuth } = await import("@/lib/server/auth.server");
  return handleConsoleAuth(request);
};

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: handleAuthRequest,
      POST: handleAuthRequest,
    },
  },
});
