import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { InsightsWindow } from "@/lib/insights-api";
import { usageMetrics } from "@/lib/insights-usage";

export function InsightsPeriodSelector({
  window,
  onWindowChange,
}: {
  readonly window: InsightsWindow;
  readonly onWindowChange: (window: InsightsWindow) => void;
}) {
  return (
    <Tabs
      value={window}
      onValueChange={(value) => {
        if (value === "24h" || value === "7d" || value === "30d")
          onWindowChange(value);
      }}
    >
      <TabsList aria-label="Reporting period" className="min-h-11 sm:min-h-9">
        {(["24h", "7d", "30d"] as const).map((value) => (
          <TabsTrigger
            key={value}
            value={value}
            aria-label={usageMetrics[value].period}
            className="min-w-12 px-3"
          >
            {value}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
