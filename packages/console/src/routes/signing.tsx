import { createFileRoute } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";

import { BundleSigningPage } from "@/components/features/signing/BundleSigningPage";
import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";

export const Route = createFileRoute("/signing")({
  component: BundleSigningRoute,
});

function BundleSigningRoute() {
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-3 sm:min-h-12 sm:flex-nowrap sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
        <SidebarTrigger className="-ml-1" />
        <div className="flex items-center gap-1.5">
          <ShieldCheck
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
          />
          <h1 className="text-sm font-medium">Bundle signing</h1>
        </div>
        <Badge variant="outline">Read-only</Badge>
        <p className="basis-full pl-9 text-xs text-muted-foreground sm:basis-auto sm:pl-0">
          Inspect the public key used to verify signed updates.
        </p>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto w-full max-w-5xl">
          <BundleSigningPage />
        </div>
      </div>
    </div>
  );
}
