import type { ActiveInstallationWindow } from "@hot-updater/server";

import { Field, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const windows = [
  { value: "24h", label: "24 hours", shortLabel: "24h" },
  { value: "7d", label: "7 days", shortLabel: "7d" },
  { value: "30d", label: "30 days", shortLabel: "30d" },
] as const;

export function InsightsControls({
  onWindowChange,
  window,
}: {
  readonly onWindowChange: (window: ActiveInstallationWindow) => void;
  readonly window: ActiveInstallationWindow;
}) {
  return (
    <section aria-label="Insights controls" className="flex">
      <Field orientation="horizontal" className="w-full">
        <FieldLabel className="sr-only">Reporting period</FieldLabel>
        <ToggleGroup
          aria-label="Reporting period"
          className="w-full sm:w-fit"
          onValueChange={(value) => {
            if (value[0]) {
              onWindowChange(value[0] as ActiveInstallationWindow);
            }
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
