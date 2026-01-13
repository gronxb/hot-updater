import { Button } from "@/components/ui/button";
import { DATE_RANGE_PRESETS } from "@/lib/constants";
import dayjs from "dayjs";
import { X } from "lucide-react";

interface DateRangePickerProps {
  startDate?: string;
  endDate?: string;
  onDateRangeChange: (startDate?: string, endDate?: string) => void;
}

export function DateRangePicker({
  startDate,
  endDate,
  onDateRangeChange,
}: DateRangePickerProps) {
  const today = dayjs().format("YYYY-MM-DD");

  const handlePresetClick = (preset: (typeof DATE_RANGE_PRESETS)[number]) => {
    const end = dayjs();
    let start: dayjs.Dayjs;

    if ("hours" in preset) {
      start = end.subtract(preset.hours, "hour");
    } else {
      start = end.subtract(preset.days, "day");
    }

    onDateRangeChange(start.format("YYYY-MM-DD"), end.format("YYYY-MM-DD"));
  };

  const handleAllTimeClick = () => {
    onDateRangeChange(undefined, undefined);
  };

  const handleClearClick = () => {
    onDateRangeChange(undefined, undefined);
  };

  const handleStartDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newStartDate = e.target.value || undefined;
    onDateRangeChange(newStartDate, endDate);
  };

  const handleEndDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newEndDate = e.target.value || undefined;
    onDateRangeChange(startDate, newEndDate);
  };

  // Validation: show warning if startDate > endDate
  const hasInvalidRange =
    startDate && endDate && dayjs(startDate).isAfter(dayjs(endDate));

  return (
    <div className="space-y-4">
      {/* Preset buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground mr-2">Quick select:</span>
        {DATE_RANGE_PRESETS.map((preset) => (
          <Button
            key={preset.label}
            variant="outline"
            size="sm"
            onClick={() => handlePresetClick(preset)}
            className="text-xs"
          >
            {preset.label}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={handleAllTimeClick}
          className="text-xs"
        >
          All Time
        </Button>
      </div>

      {/* Date inputs */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label htmlFor="start-date" className="text-sm font-medium">
            Start Date:
          </label>
          <input
            id="start-date"
            type="date"
            value={startDate || ""}
            max={today}
            onChange={handleStartDateChange}
            className="px-3 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="end-date" className="text-sm font-medium">
            End Date:
          </label>
          <input
            id="end-date"
            type="date"
            value={endDate || ""}
            max={today}
            onChange={handleEndDateChange}
            className="px-3 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {(startDate || endDate) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearClick}
            className="text-xs"
          >
            <X className="h-4 w-4 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {/* Validation warning */}
      {hasInvalidRange && (
        <div className="text-xs text-destructive">
          Start date must be before end date
        </div>
      )}
    </div>
  );
}
