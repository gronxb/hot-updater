import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
          <Input
            className="h-11 sm:h-9"
            id="insights-channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            required
            maxLength={1024}
          />
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
