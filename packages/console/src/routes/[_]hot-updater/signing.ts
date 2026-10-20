import { createFileRoute } from "@tanstack/react-router";

// Remote bundle signing takes a vault token, not a session: see vaultRoutes.ts.
const handle = async ({ request }: { readonly request: Request }) => {
  const [{ loadConsole }, { serveVaultSigning }] = await Promise.all([
    import("@/lib/server/config.server"),
    import("@/lib/server/vaultRoutes"),
  ]);
  return serveVaultSigning(request, loadConsole);
};

export const Route = createFileRoute("/_hot-updater/signing")({
  server: {
    // The signing protocol answers 405 itself, once the token is accepted.
    handlers: { ANY: handle },
  },
});
