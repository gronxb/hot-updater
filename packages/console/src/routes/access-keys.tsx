import { createFileRoute } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";

import { AccessKeysPage } from "@/components/features/access-keys/AccessKeysPage";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ensureClientAccessKeyRouteAccess } from "@/lib/access-keys-api";

export const Route = createFileRoute("/access-keys")({
  beforeLoad: ({ context }) =>
    ensureClientAccessKeyRouteAccess(context.queryClient),
  component: AccessKeysRoute,
});

function AccessKeysRoute() {
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-3 sm:min-h-12 sm:flex-nowrap sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
        <SidebarTrigger className="-ml-1" />
        <div className="flex items-center gap-1.5">
          <KeyRound
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
          />
          <h1 className="text-sm font-medium">Access keys</h1>
        </div>
        <p className="basis-full pl-9 text-xs text-muted-foreground sm:basis-auto sm:pl-0">
          Control app access to OTA and analytics ingestion endpoints.
        </p>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto w-full max-w-6xl">
          <AccessKeysPage />
        </div>
      </div>
    </div>
  );
}
