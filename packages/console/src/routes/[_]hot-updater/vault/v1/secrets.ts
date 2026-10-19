import { createFileRoute } from "@tanstack/react-router";

// The vault's routes take a vault token, not a session: see vaultRoutes.ts.
export const Route = createFileRoute("/_hot-updater/vault/v1/secrets")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const [{ loadConsole }, { listVaultSecrets }] = await Promise.all([
          import("@/lib/server/config.server"),
          import("@/lib/server/vaultRoutes"),
        ]);
        return listVaultSecrets(request, loadConsole);
      },
    },
  },
});
