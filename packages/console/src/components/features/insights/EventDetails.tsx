import {
  Activity,
  Check,
  ChevronDown,
  Download,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";

import { HashValueDisplay } from "@/components/HashValueDisplay";
import { Badge } from "@/components/ui/badge";
import type { InsightsEventRow } from "@/lib/insights-view";

type EventHistoryRow = InsightsEventRow;

const eventTypes = {
  UPDATE_DOWNLOADED: {
    label: "Downloaded",
    description:
      "Download complete. Waiting for the app to restart and apply it.",
    variant: "secondary",
    icon: Download,
  },
  UPDATE_APPLIED: {
    label: "Update applied",
    description: "The app started using the downloaded update.",
    variant: "success",
    icon: Check,
  },
  RECOVERED: {
    label: "Recovered",
    description: "Recovered from a crashed bundle.",
    variant: "warning",
    icon: RotateCcw,
  },
  UNCHANGED: {
    label: "No change",
    description: "No download or apply was reported at this point.",
    variant: "secondary",
    icon: Activity,
  },
} as const;

export function useInsightsTimeFormat() {
  const [timeZone, setTimeZone] = useState("UTC");
  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  return new Intl.DateTimeFormat("en", {
    timeZone,
    timeZoneName: "shortOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

export function formatInsightsTimestamp(
  value: number,
  formatter: Intl.DateTimeFormat,
) {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(value))
      .map(({ type, value }) => [type, value]),
  );
  const offset = parts.timeZoneName === "GMT" ? "GMT+0" : parts.timeZoneName;
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${offset}`;
}

export function EventTimestamp({
  value,
  formatter,
  touch = false,
}: {
  readonly value: number;
  readonly formatter: Intl.DateTimeFormat;
  readonly touch?: boolean;
}) {
  const date = new Date(value);
  const localTime = formatInsightsTimestamp(value, formatter);
  return (
    <details className="group/time">
      <summary
        className={`cursor-pointer list-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden ${touch ? "flex min-h-11 items-center" : ""}`}
      >
        <span className="flex items-center gap-1">
          <time dateTime={date.toISOString()} className="whitespace-nowrap">
            {localTime}
          </time>
          <ChevronDown
            aria-hidden="true"
            className="size-3 text-muted-foreground group-open/time:rotate-180"
          />
        </span>
      </summary>
      <p className="mt-2 text-muted-foreground">
        {date.toISOString().replace("T", " ").replace("Z", " UTC")}
      </p>
    </details>
  );
}

export function EventTypeDetails({
  type,
}: {
  readonly type: EventHistoryRow["type"];
}) {
  const eventType = eventTypes[type];
  const Icon = eventType.icon;
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <Badge
        variant={eventType.variant}
        className="gap-1 whitespace-nowrap [&_svg]:size-3"
      >
        <Icon aria-hidden="true" />
        {eventType.label}
      </Badge>
      <p className="max-w-56 whitespace-normal text-xs text-muted-foreground">
        {eventType.description}
      </p>
    </div>
  );
}

export function EventBundleTransition({
  event,
  touch = false,
}: {
  readonly event: Pick<EventHistoryRow, "type" | "fromBundleId" | "toBundleId">;
  readonly touch?: boolean;
}) {
  const downloaded = event.type === "UPDATE_DOWNLOADED";
  const changed =
    downloaded || event.type === "UPDATE_APPLIED" || event.type === "RECOVERED";
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
      {event.fromBundleId && changed ? (
        <>
          <dt className="text-muted-foreground">
            {downloaded ? "Running" : "From"}
          </dt>
          <dd>
            <HashValueDisplay
              value={event.fromBundleId}
              buttonClassName={touch ? "min-h-11 px-3" : undefined}
            />
          </dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">
        {downloaded ? "Pending" : changed ? "To" : "Current"}
      </dt>
      <dd>
        <HashValueDisplay
          value={event.toBundleId}
          buttonClassName={touch ? "min-h-11 px-3" : undefined}
        />
      </dd>
    </dl>
  );
}
