import { createFileRoute } from "@tanstack/react-router";

// The vault's routes take a vault token, not a session: see vaultRoutes.ts.
export const Route = createFileRoute("/_hot-updater/vault/v1/secrets/$name")({
  server: {
    handlers: {
      PUT: async ({ request, params }) => {
        const [{ loadConsole }, { putVaultSecret }] = await Promise.all([
          import("@/lib/server/config.server"),
          import("@/lib/server/vaultRoutes"),
        ]);
        return putVaultSecret(request, params.name, loadConsole);
      },
      ANY: async () => {
        const { vaultMethodNotAllowed } =
          await import("@/lib/server/vaultRoutes");
        return vaultMethodNotAllowed("PUT");
      },
    },
  },
});
