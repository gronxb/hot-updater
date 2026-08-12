import { Filter, Settings2, X } from "lucide-react";
import { useState } from "react";

import { ChannelManagementDialog } from "@/components/features/bundles/ChannelManagementDialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useFilterParams } from "@/hooks/useFilterParams";
import { useChannelsQuery } from "@/lib/api";

export function FilterToolbar() {
  const [isChannelManagementOpen, setIsChannelManagementOpen] = useState(false);
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
          <SelectGroup>
            <SelectItem value="all">All Platforms</SelectItem>
            <SelectItem value="ios">iOS</SelectItem>
            <SelectItem value="android">Android</SelectItem>
          </SelectGroup>
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
          <SelectGroup>
            <SelectItem value="all">All Channels</SelectItem>
            {channels.map((channel) => (
              <SelectItem key={channel.id} value={channel.name}>
                {channel.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => setIsChannelManagementOpen(true)}
        aria-label="Manage channels"
        className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <Settings2 data-icon="inline-start" />
        <span className="hidden sm:inline">Channels</span>
      </Button>

      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={resetFilters}
          className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground sm:ml-auto"
        >
          <X data-icon="inline-start" />
          Clear
        </Button>
      )}

      <ChannelManagementDialog
        open={isChannelManagementOpen}
        onOpenChange={setIsChannelManagementOpen}
      />
    </header>
  );
}
