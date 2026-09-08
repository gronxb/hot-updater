import { useState } from "react";

import { PlatformIcon } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useChannelsQuery } from "@/lib/api";
import type { AppUsageScope } from "@/lib/insights-usage";

export function InsightsControls({
  onScopeChange,
  scope,
  appVersions,
}: {
  readonly onScopeChange: (scope: AppUsageScope) => void;
  readonly scope: AppUsageScope;
  readonly appVersions: readonly string[];
}) {
  const [platform, setPlatform] = useState(scope.platform);
  const [channel, setChannel] = useState(scope.channel);
  const [appVersion, setAppVersion] = useState(scope.appVersion ?? "");
  const versions = [
    ...new Set([...appVersions, ...(appVersion ? [appVersion] : [])]),
  ];
  const channelsQuery = useChannelsQuery();
  const channels = channelsQuery.data?.map((item) => item.name) ?? [];

  return (
    <form
      aria-label="Insights controls"
      onSubmit={(event) => {
        event.preventDefault();
        onScopeChange({
          platform,
          channel,
          ...(appVersion ? { appVersion } : {}),
        });
      }}
    >
      <FieldGroup className="grid grid-cols-2 items-end gap-4 lg:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Field>
          <FieldLabel htmlFor="insights-platform">Platform</FieldLabel>
          <Select
            items={{ all: "All platforms", ios: "iOS", android: "Android" }}
            value={platform}
            onValueChange={(value) => {
              if (value === "all" || value === "ios" || value === "android")
                setPlatform(value);
            }}
          >
            <SelectTrigger
              id="insights-platform"
              className="min-h-11 w-full sm:min-h-9"
            >
              <SelectValue>
                {platform !== "all" ? (
                  <PlatformIcon platform={platform} className="size-3.5" />
                ) : null}
                {platform === "all"
                  ? "All platforms"
                  : platform === "ios"
                    ? "iOS"
                    : "Android"}
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
        </Field>
        <Field className="min-w-0">
          <FieldLabel htmlFor="insights-channel">Channel</FieldLabel>
          <Combobox
            items={channels}
            value={channel}
            onValueChange={(value) => {
              if (value !== null) setChannel(value);
            }}
          >
            <ComboboxInput
              className="h-11 w-full sm:h-9 [&_input]:h-full"
              id="insights-channel"
              placeholder="Search channels"
              maxLength={1024}
            />
            <ComboboxContent>
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
        </Field>
        <Field className="min-w-0">
          <FieldLabel htmlFor="insights-app-version">App version</FieldLabel>
          <Select
            items={Object.fromEntries([
              ["all", "All versions"],
              ...versions.map((version) => [`version:${version}`, version]),
            ])}
            value={appVersion ? `version:${appVersion}` : "all"}
            onValueChange={(value) => {
              if (value !== null)
                setAppVersion(value === "all" ? "" : value.slice(8));
            }}
          >
            <SelectTrigger
              id="insights-app-version"
              className="min-h-11 w-full sm:min-h-9"
            >
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
        </Field>
        <Button
          className="h-11 sm:h-9"
          size="lg"
          type="submit"
          variant="outline"
        >
          Apply filters
        </Button>
      </FieldGroup>
    </form>
  );
}
