import { extractTimestampFromUUIDv7 } from "@hot-updater/plugin-core";

interface TimestampDisplayProps {
  uuid: string;
  format?: "relative" | "absolute" | "both";
}

const absoluteDateFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  year: "numeric",
});

const relativeTimeFormatter = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
});

function formatAbsoluteDate(timestamp: number): string {
  return absoluteDateFormatter
    .format(new Date(timestamp))
    .replace(",", "")
    .replace(/\//g, "-");
}

function formatRelativeTime(timestamp: number): string {
  const elapsedSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absSeconds = Math.abs(elapsedSeconds);

  if (absSeconds < 60) {
    return relativeTimeFormatter.format(elapsedSeconds, "second");
  }

  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (Math.abs(elapsedMinutes) < 60) {
    return relativeTimeFormatter.format(elapsedMinutes, "minute");
  }

  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (Math.abs(elapsedHours) < 24) {
    return relativeTimeFormatter.format(elapsedHours, "hour");
  }

  const elapsedDays = Math.round(elapsedHours / 24);
  if (Math.abs(elapsedDays) < 30) {
    return relativeTimeFormatter.format(elapsedDays, "day");
  }

  const elapsedMonths = Math.round(elapsedDays / 30);
  if (Math.abs(elapsedMonths) < 12) {
    return relativeTimeFormatter.format(elapsedMonths, "month");
  }

  return relativeTimeFormatter.format(Math.round(elapsedDays / 365), "year");
}

export function TimestampDisplay({
  uuid,
  format = "relative",
}: TimestampDisplayProps) {
  const timestamp = extractTimestampFromUUIDv7(uuid);
  const relativeTime = formatRelativeTime(timestamp);
  const absoluteDate = formatAbsoluteDate(timestamp);

  if (format === "relative") {
    return (
      <span className="text-sm text-muted-foreground">{relativeTime}</span>
    );
  }

  if (format === "absolute") {
    return (
      <span className="text-sm text-muted-foreground">{absoluteDate}</span>
    );
  }

  return (
    <div className="flex flex-col">
      <span className="text-sm">{relativeTime}</span>
      <span className="text-xs text-muted-foreground">{absoluteDate}</span>
    </div>
  );
}
