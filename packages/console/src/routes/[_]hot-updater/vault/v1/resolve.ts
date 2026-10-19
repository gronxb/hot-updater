import { createFileRoute } from "@tanstack/react-router";

// The vault's routes take a vault token, not a session: see vaultRoutes.ts.
export const Route = createFileRoute("/_hot-updater/vault/v1/resolve")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const [{ loadConsole }, { resolveVaultSecrets }] = await Promise.all([
          import("@/lib/server/config.server"),
          import("@/lib/server/vaultRoutes"),
        ]);
        return resolveVaultSecrets(request, loadConsole);
      },
      ANY: async () => {
        const { vaultMethodNotAllowed } =
          await import("@/lib/server/vaultRoutes");
        return vaultMethodNotAllowed("POST");
      },
    },
  },
});
