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
    <section
      aria-label="Insights controls"
      className="rounded-xl border bg-background px-4 py-3"
    >
      <Field
        orientation="horizontal"
        className="flex-col items-start gap-3 sm:flex-row sm:items-center"
      >
        <FieldLabel>Reporting period</FieldLabel>
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
              className="flex-1 sm:flex-none"
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
