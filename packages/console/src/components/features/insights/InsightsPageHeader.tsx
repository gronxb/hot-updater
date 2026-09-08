import { Link } from "@tanstack/react-router";
import { ChartNoAxesCombined, ListIcon } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { InsightsSearch } from "@/lib/insights-search";
import { cn } from "@/lib/utils";

export function InsightsPageHeader({
  view,
  overviewSearch,
}: {
  readonly view: "overview" | "events" | "distribution";
  readonly overviewSearch?: InsightsSearch;
}) {
  return (
    <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-3 border-b bg-background px-3 py-3 sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
      <SidebarTrigger className="-ml-1 size-11 lg:size-7" />
      <div className="flex items-center gap-1.5">
        <ChartNoAxesCombined
          aria-hidden="true"
          className="size-3.5 text-muted-foreground"
        />
        <h1 className="text-sm font-medium">Insights</h1>
      </div>
      <nav aria-label="Insights views" className="ml-auto flex gap-2">
        <Link
          aria-current={view === "overview" ? "page" : undefined}
          className={cn(
            buttonVariants({
              className: "h-11 px-3 lg:h-8 lg:px-2.5",
              size: "lg",
              variant: view === "overview" ? "secondary" : "ghost",
            }),
          )}
          search={overviewSearch}
          to="/insights"
        >
          Overview
        </Link>
        <Link
          aria-current={view === "events" ? "page" : undefined}
          className={cn(
            buttonVariants({
              className: "h-11 px-3 lg:h-8 lg:px-2.5",
              size: "lg",
              variant: view === "events" ? "secondary" : "ghost",
            }),
          )}
          to="/installations"
        >
          <ListIcon aria-hidden="true" data-icon="inline-start" />
          All events
        </Link>
      </nav>
    </header>
  );
}
