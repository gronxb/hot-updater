import {
  Activity,
  Check,
  ChevronDown,
  PackageCheck,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";

import { HashValueDisplay } from "@/components/HashValueDisplay";
import { Badge } from "@/components/ui/badge";
import type { EventHistoryResult } from "@/lib/api";

type EventHistoryRow = EventHistoryResult["data"][number];

const eventTypes = {
  UPDATE_APPLIED: { label: "Bundle applied", variant: "success", icon: Check },
  RECOVERED: { label: "Recovered", variant: "warning", icon: RotateCcw },
  RELEASE_ADOPTED: {
    label: "Release adopted",
    variant: "success",
    icon: PackageCheck,
  },
  UNCHANGED: {
    label: "Activity reported",
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
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
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
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  const localTime = `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
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

export function EventTypeBadge({
  type,
}: {
  readonly type: EventHistoryRow["type"];
}) {
  const eventType = eventTypes[type];
  const Icon = eventType.icon;
  return (
    <Badge
      variant={eventType.variant}
      className="gap-1 whitespace-nowrap [&_svg]:size-3"
      title={
        type === "UNCHANGED"
          ? "App activity reported on the current bundle without a bundle transition."
          : undefined
      }
    >
      <Icon aria-hidden="true" />
      {eventType.label}
    </Badge>
  );
}

export function EventBundleTransition({
  event,
  touch = false,
}: {
  readonly event: Pick<EventHistoryRow, "type" | "fromBundleId" | "toBundleId">;
  readonly touch?: boolean;
}) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
      {event.fromBundleId ? (
        <>
          <dt className="text-muted-foreground">From</dt>
          <dd>
            <HashValueDisplay
              value={event.fromBundleId}
              buttonClassName={touch ? "min-h-11 px-3" : undefined}
            />
          </dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">
        {event.type === "UNCHANGED" ? "Current" : "To"}
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
