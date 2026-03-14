import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { extractTimestampFromUUIDv7 } from "@/lib/extract-timestamp-from-uuidv7";

dayjs.extend(relativeTime);

interface TimestampDisplayProps {
  uuid: string;
  format?: "relative" | "absolute" | "both";
}

export function TimestampDisplay({
  uuid,
  format = "relative",
}: TimestampDisplayProps) {
  const timestamp = extractTimestampFromUUIDv7(uuid);
  const date = dayjs(timestamp);

  if (format === "relative") {
    return (
      <span className="text-sm text-muted-foreground">{date.fromNow()}</span>
    );
  }

  if (format === "absolute") {
    return (
      <span className="text-sm text-muted-foreground">
        {date.format("YYYY-MM-DD HH:mm:ss")}
      </span>
    );
  }

  return (
    <div className="flex flex-col">
      <span className="text-sm">{date.fromNow()}</span>
      <span className="text-xs text-muted-foreground">
        {date.format("YYYY-MM-DD HH:mm:ss")}
      </span>
    </div>
  );
}
