import { Filter, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useFilterParams } from "@/hooks/useFilterParams";
import { useChannelsQuery } from "@/lib/api";

export function FilterToolbar() {
  const { filters, setFilters, resetFilters } = useFilterParams();
  const { data: channels = [] } = useChannelsQuery();

  const hasActiveFilters = filters.channel || filters.platform;

  return (
    <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-3 sm:h-12 sm:flex-nowrap sm:bg-card/70 sm:px-4 sm:py-0 sm:backdrop-blur-sm">
      <SidebarTrigger className="-ml-1" />

      <div className="ml-1 flex items-center gap-1.5 text-muted-foreground sm:ml-2">
        <Filter className="h-3.5 w-3.5" />
        <span className="text-xs font-medium">Filters</span>
      </div>

      <Select
        value={filters.platform || "all"}
        onValueChange={(value) =>
          setFilters({
            platform:
              value === "all" ? undefined : (value as "ios" | "android"),
          })
        }
      >
        <SelectTrigger className="h-8 w-[calc(50%-0.25rem)] min-w-[132px] text-xs sm:w-[140px]">
          <SelectValue placeholder="All Platforms" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Platforms</SelectItem>
          <SelectItem value="ios">iOS</SelectItem>
          <SelectItem value="android">Android</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={filters.channel || "all"}
        onValueChange={(value) =>
          setFilters({ channel: value === "all" ? undefined : value })
        }
      >
        <SelectTrigger className="h-8 w-[calc(50%-0.25rem)] min-w-[132px] text-xs sm:w-[140px]">
          <SelectValue placeholder="All Channels" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Channels</SelectItem>
          {channels.map((channel) => (
            <SelectItem key={channel} value={channel}>
              {channel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={resetFilters}
          className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground sm:ml-auto"
        >
          <X className="h-3.5 w-3.5 mr-1" />
          Clear
        </Button>
      )}
    </header>
  );
}
