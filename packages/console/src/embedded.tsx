import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import "./embedded.css";
import { ConsoleBundlesPage } from "@/components/ConsoleBundlesPage";
import { FilterParamsProvider } from "@/hooks/useFilterParams";
import {
  type BundleFilters,
  type ConsoleApiClient,
  ConsoleApiProvider,
} from "@/lib/api";

export type HotUpdaterConsoleProps = {
  readonly api: ConsoleApiClient;
  readonly initialBundleId?: string;
  readonly initialExpandedBundleId?: string;
  readonly initialFilters?: BundleFilters;
  readonly project?: {
    readonly id?: string;
    readonly name?: string;
    readonly runtimeUrl?: string;
  };
};

export function HotUpdaterConsole({
  api,
  initialBundleId,
  initialExpandedBundleId,
  initialFilters,
  project,
}: HotUpdaterConsoleProps) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <div
      data-hot-updater-console="embedded"
      data-project-id={project?.id}
      data-project-name={project?.name}
      data-runtime-url={project?.runtimeUrl}
      aria-label={`Bundle console for ${project?.name ?? "project"}`}
      className="hot-updater-console-embedded h-[min(760px,calc(100svh-11rem))] min-h-[420px] min-w-0 overflow-hidden rounded-lg border bg-background text-foreground"
    >
      <QueryClientProvider client={queryClient}>
        <ConsoleApiProvider client={api}>
          <FilterParamsProvider
            initialBundleId={initialBundleId}
            initialExpandedBundleId={initialExpandedBundleId}
            initialFilters={initialFilters}
          >
            <ConsoleBundlesPage embedded />
          </FilterParamsProvider>
        </ConsoleApiProvider>
      </QueryClientProvider>
    </div>
  );
}

export type { BundleFilters, ConsoleApiClient };
