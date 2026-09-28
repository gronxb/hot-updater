import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { InsightsWindow } from "@/lib/insights-api";
import { usageMetrics } from "@/lib/insights-usage";

/** A segmented control over fixed periods, each shown by its short value. */
export function PeriodSelector<TPeriod extends string>({
  label,
  onPeriodChange,
  period,
  periods,
}: {
  readonly label: string;
  readonly onPeriodChange: (period: TPeriod) => void;
  readonly period: TPeriod;
  readonly periods: readonly {
    readonly value: TPeriod;
    readonly name: string;
  }[];
}) {
  return (
    <Tabs
      value={period}
      onValueChange={(value) => {
        const next = periods.find((item) => item.value === value);
        if (next) onPeriodChange(next.value);
      }}
    >
      <TabsList aria-label={label} className="min-h-11 sm:min-h-9">
        {periods.map(({ value, name }) => (
          <TabsTrigger
            key={value}
            value={value}
            aria-label={name}
            className="min-w-12 px-3"
          >
            {value}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

const reportingPeriods = (["24h", "7d", "30d"] as const).map((value) => ({
  value,
  name: usageMetrics[value].period,
}));

export function InsightsPeriodSelector({
  window,
  onWindowChange,
}: {
  readonly window: InsightsWindow;
  readonly onWindowChange: (window: InsightsWindow) => void;
}) {
  return (
    <PeriodSelector
      label="Reporting period"
      onPeriodChange={onWindowChange}
      period={window}
      periods={reportingPeriods}
    />
  );
}
