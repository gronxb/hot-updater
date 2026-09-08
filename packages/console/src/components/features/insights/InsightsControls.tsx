import { useState } from "react";

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
import type { InsightsOverviewInput } from "@/lib/insights-api";

export function InsightsControls({
  onScopeChange,
  scope,
}: {
  readonly onScopeChange: (
    scope: Omit<InsightsOverviewInput, "window">,
  ) => void;
  readonly scope: Omit<InsightsOverviewInput, "window">;
}) {
  const [platform, setPlatform] = useState(scope.platform);
  const [channel, setChannel] = useState(scope.channel);
  const channelsQuery = useChannelsQuery();
  const channels = channelsQuery.data?.map((item) => item.name) ?? [];

  return (
    <form
      aria-label="Insights controls"
      onSubmit={(event) => {
        event.preventDefault();
        onScopeChange({ platform, channel });
      }}
    >
      <FieldGroup className="grid grid-cols-[1fr_2fr] items-end gap-4 sm:flex-row sm:flex">
        <Field className="sm:w-36">
          <FieldLabel htmlFor="insights-platform">Platform</FieldLabel>
          <Select
            items={{ ios: "iOS", android: "Android" }}
            value={platform}
            onValueChange={(value) => {
              if (value === "ios" || value === "android") setPlatform(value);
            }}
          >
            <SelectTrigger
              id="insights-platform"
              className="min-h-11 w-full sm:min-h-9"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="ios">iOS</SelectItem>
                <SelectItem value="android">Android</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="min-w-0 sm:max-w-xs">
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
        <Button
          className="col-span-2 h-11 sm:h-9 sm:w-auto"
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
