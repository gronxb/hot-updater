import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, useState } from "react";

import { ConsoleBundlesPage } from "./components/ConsoleBundlesPage";
import { ThemeProvider } from "./components/ThemeProvider";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { ConsoleFilterParamsProvider } from "./hooks/useFilterParams";
import {
  ConsoleApiClientProvider,
  type BundleFilters,
  type ConsoleApiClient,
} from "./lib/api-client";

import "./styles.css";

export type HotUpdaterConsoleProps = {
  api: ConsoleApiClient;
  initialBundleId?: string;
  initialExpandedBundleId?: string;
  initialFilters?: BundleFilters;
};

export function HotUpdaterConsole({
  api,
  initialBundleId,
  initialExpandedBundleId,
  initialFilters,
}: HotUpdaterConsoleProps): ReactElement {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={queryClient}>
        <ConsoleApiClientProvider api={api}>
          <ConsoleFilterParamsProvider
            initialBundleId={initialBundleId}
            initialExpandedBundleId={initialExpandedBundleId}
            initialFilters={initialFilters}
          >
            <TooltipProvider>
              <div className="min-h-svh bg-background text-foreground">
                <ConsoleBundlesPage showSidebarTrigger={false} />
              </div>
              <Toaster />
            </TooltipProvider>
          </ConsoleFilterParamsProvider>
        </ConsoleApiClientProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export type { BundleFilters, ConsoleApiClient };
