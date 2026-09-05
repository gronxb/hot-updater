import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { InsightsOverviewInput, InsightsWindow } from "@/lib/insights-api";

const windows = [
  { value: "24h", label: "24 hours", shortLabel: "24h" },
  { value: "7d", label: "7 days", shortLabel: "7d" },
  { value: "30d", label: "30 days", shortLabel: "30d" },
] as const;

export function InsightsControls({
  onWindowChange,
  onScopeChange,
  scope,
  window,
}: {
  readonly onWindowChange: (window: InsightsWindow) => void;
  readonly onScopeChange: (
    scope: Omit<InsightsOverviewInput, "window">,
  ) => void;
  readonly scope: Omit<InsightsOverviewInput, "window">;
  readonly window: InsightsWindow;
}) {
  const [platform, setPlatform] = useState(scope.platform);
  const [channel, setChannel] = useState(scope.channel);
  const [bundleId, setBundleId] = useState(scope.bundleId ?? "");

  return (
    <section aria-label="Insights controls" className="flex flex-col gap-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onScopeChange({ platform, channel, bundleId: bundleId || undefined });
        }}
      >
        <FieldGroup className="items-end sm:flex-row">
          <Field className="w-full sm:w-auto">
            <FieldLabel>Platform</FieldLabel>
            <ToggleGroup
              aria-label="Platform"
              value={[platform]}
              onValueChange={(value) => {
                if (value[0] === "ios" || value[0] === "android")
                  setPlatform(value[0]);
              }}
              spacing={0}
              variant="outline"
            >
              <ToggleGroupItem className="h-11 lg:h-8" value="ios">
                iOS
              </ToggleGroupItem>
              <ToggleGroupItem className="h-11 lg:h-8" value="android">
                Android
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field>
            <FieldLabel htmlFor="insights-channel">Channel</FieldLabel>
            <Input
              className="h-11 lg:h-8"
              id="insights-channel"
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
              required
              maxLength={1024}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="insights-bundle">
              Bundle ID (optional)
            </FieldLabel>
            <Input
              className="h-11 lg:h-8"
              id="insights-bundle"
              placeholder="Select a bundle by ID"
              value={bundleId}
              onChange={(event) => setBundleId(event.target.value)}
              maxLength={1024}
            />
          </Field>
          <Button
            className="h-11 w-full sm:w-auto lg:h-8"
            type="submit"
            variant="outline"
          >
            Apply filters
          </Button>
        </FieldGroup>
      </form>
      <Field orientation="horizontal" className="w-full">
        <FieldLabel className="sr-only">Reporting period</FieldLabel>
        <ToggleGroup
          aria-label="Reporting period"
          className="w-full sm:w-fit"
          onValueChange={(value) => {
            if (value[0]) onWindowChange(value[0] as InsightsWindow);
          }}
          spacing={0}
          size="lg"
          value={[window]}
          variant="outline"
        >
          {windows.map((item) => (
            <ToggleGroupItem
              aria-label={item.label}
              className="h-11 flex-1 px-4 sm:flex-none lg:h-8 lg:px-2.5"
              key={item.value}
              value={item.value}
            >
              {item.shortLabel}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
    </section>
  );
}
