import { RotateCcw, X } from "lucide-react";
import type { ReactNode } from "react";

import { PlatformIcon } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useChannelsQuery } from "@/lib/api";
import { DEFAULT_INSIGHTS_CHANNEL } from "@/lib/insights-search";
import type { AdoptionRelease, HealthPlatform } from "@/lib/release-adoption";

import { platformLabel } from "./InsightsScope";
import { ReleaseCombobox } from "./ReleaseCombobox";

/** The Insights filters as the URL holds them. */
export type InsightsFilters = {
  readonly channel: string;
  readonly platform: HealthPlatform;
  readonly appVersion?: string;
  readonly releaseId?: string;
};

const DEFAULT_FILTERS = {
  channel: DEFAULT_INSIGHTS_CHANNEL,
  platform: "all",
  appVersion: undefined,
  releaseId: undefined,
} as const satisfies InsightsFilters;

// One look for every filter; a filter narrower than its default is filled.
const CHIP =
  "h-11 shrink-0 gap-1.5 px-3 text-sm data-[active=true]:border-primary/60 data-[active=true]:bg-primary/10 sm:h-8 sm:text-xs";
const SELECT_CHIP =
  "shrink-0 gap-1.5 px-3 text-sm data-[active=true]:border-primary/60 data-[active=true]:bg-primary/10 data-[size=default]:h-11 sm:text-xs sm:data-[size=default]:h-8";

/** A filter with a button that returns it to its default when it is narrowed. */
function Clearable({
  name,
  active,
  onClear,
  children,
}: {
  readonly name: string;
  readonly active: boolean;
  readonly onClear: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center">
      {children}
      {active ? (
        <Button
          aria-label={`Clear ${name}`}
          className="size-11 sm:size-8"
          size="icon"
          variant="ghost"
          onClick={onClear}
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The Insights filters, above every report. Each applies as it changes, so
 * what they show is what the reports read; one narrower than its default is
 * filled and can be cleared on its own, and Reset filters clears them all.
 */
export function InsightsControls({
  filters,
  appVersions,
  releases,
  onFiltersChange,
}: {
  readonly filters: InsightsFilters;
  readonly appVersions: readonly string[];
  /** The channel's bundle deployments a release filter offers. */
  readonly releases: readonly AdoptionRelease[];
  readonly onFiltersChange: (change: Partial<InsightsFilters>) => void;
}) {
  const versions = [
    ...new Set([
      ...appVersions,
      ...(filters.appVersion ? [filters.appVersion] : []),
    ]),
  ];
  const channelsQuery = useChannelsQuery();
  const channels = channelsQuery.data?.map((item) => item.name) ?? [];
  const narrowed = {
    channel: filters.channel !== DEFAULT_FILTERS.channel,
    platform: filters.platform !== DEFAULT_FILTERS.platform,
    appVersion: filters.appVersion !== undefined,
    releaseId: filters.releaseId !== undefined,
  };

  return (
    <div
      aria-label="Insights filters"
      className="flex shrink-0 items-center gap-2 overflow-x-auto border-b bg-background px-3 py-2 sm:flex-wrap sm:overflow-visible sm:px-4"
      role="group"
    >
      <Combobox
        items={channels}
        value={filters.channel}
        onValueChange={(value) => {
          if (value !== null && value !== filters.channel)
            onFiltersChange({ channel: value });
        }}
      >
        <ComboboxTrigger
          aria-label={`Channel: ${filters.channel}`}
          data-active={narrowed.channel}
          render={<Button className={CHIP} variant="outline" />}
        >
          <span className="text-muted-foreground">Channel</span>
          <span className="max-w-48 truncate">{filters.channel}</span>
        </ComboboxTrigger>
        <ComboboxContent className="w-64">
          <ComboboxInput
            aria-label="Search channels"
            placeholder="Search channels…"
            showTrigger={false}
            maxLength={1024}
          />
          <ComboboxEmpty>
            {channelsQuery.isPending ? (
              "Loading channels…"
            ) : channelsQuery.isError ? (
              <div className="flex flex-col items-center gap-2 p-2">
                Couldn't load channels.
                <Button
                  onClick={() => void channelsQuery.refetch()}
                  size="sm"
                  variant="outline"
                >
                  Retry channels
                </Button>
              </div>
            ) : (
              "No channels found."
            )}
          </ComboboxEmpty>
          <ComboboxList>
            {(item: string) => (
              <ComboboxItem
                className="min-h-11 pr-8 sm:min-h-8"
                key={item}
                value={item}
              >
                <span className="truncate">{item}</span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <Clearable
        name="platform"
        active={narrowed.platform}
        onClear={() => onFiltersChange({ platform: DEFAULT_FILTERS.platform })}
      >
        <Select
          items={{ all: "All platforms", ios: "iOS", android: "Android" }}
          value={filters.platform}
          onValueChange={(value) => {
            if (
              (value === "all" || value === "ios" || value === "android") &&
              value !== filters.platform
            )
              onFiltersChange({ platform: value });
          }}
        >
          <SelectTrigger
            aria-label="Platform"
            className={SELECT_CHIP}
            data-active={narrowed.platform}
          >
            <span className="text-muted-foreground">Platform</span>
            <SelectValue>
              {filters.platform === "all" ? null : (
                <PlatformIcon
                  platform={filters.platform}
                  className="size-3.5"
                />
              )}
              {platformLabel(filters.platform)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All platforms</SelectItem>
              <SelectItem value="ios">
                <PlatformIcon platform="ios" className="size-3.5" />
                iOS
              </SelectItem>
              <SelectItem value="android">
                <PlatformIcon platform="android" className="size-3.5" />
                Android
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Clearable>
      <Clearable
        name="app version"
        active={narrowed.appVersion}
        onClear={() => onFiltersChange({ appVersion: undefined })}
      >
        <Select
          items={Object.fromEntries([
            ["all", "All versions"],
            ...versions.map((version) => [`version:${version}`, version]),
          ])}
          value={filters.appVersion ? `version:${filters.appVersion}` : "all"}
          onValueChange={(value) => {
            if (value === null) return;
            const appVersion = value === "all" ? undefined : value.slice(8);
            if (appVersion !== filters.appVersion)
              onFiltersChange({ appVersion });
          }}
        >
          <SelectTrigger
            aria-label="App version"
            className={SELECT_CHIP}
            data-active={narrowed.appVersion}
          >
            <span className="text-muted-foreground">App version</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All versions</SelectItem>
              {versions.map((version) => (
                <SelectItem key={version} value={`version:${version}`}>
                  {version}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Clearable>
      <Clearable
        name="release"
        active={narrowed.releaseId}
        onClear={() => onFiltersChange({ releaseId: undefined })}
      >
        <ReleaseCombobox
          scope={{ channel: filters.channel, platform: filters.platform }}
          candidates={releases}
          excluded={filters.releaseId ? [filters.releaseId] : []}
          label="Search releases"
          placeholder="Search by ID or app version…"
          onPick={(release) =>
            onFiltersChange({ releaseId: release.releaseId })
          }
          trigger={
            <ComboboxTrigger
              aria-label={`Release: ${filters.releaseId ?? "All"}`}
              data-active={narrowed.releaseId}
              render={<Button className={CHIP} variant="outline" />}
            >
              <span className="text-muted-foreground">Release</span>
              {filters.releaseId ? (
                <span className="max-w-36 truncate font-mono" translate="no">
                  {filters.releaseId}
                </span>
              ) : (
                "All"
              )}
            </ComboboxTrigger>
          }
        />
      </Clearable>
      {Object.values(narrowed).some(Boolean) ? (
        <Button
          className="h-11 shrink-0 sm:h-8"
          variant="ghost"
          onClick={() => onFiltersChange(DEFAULT_FILTERS)}
        >
          <RotateCcw aria-hidden="true" data-icon="inline-start" />
          Reset filters
        </Button>
      ) : null}
    </div>
  );
}
