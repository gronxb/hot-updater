import { useEffect, useMemo, useState } from "react";

import { createDateTimeText } from "@/lib/remote-config-draft";

/**
 * Dates in the viewer's time zone, with its name. The server renders in UTC,
 * and the page switches once mounted, so both render the same first.
 */
export function useDateTimeText() {
  const [timeZone, setTimeZone] = useState("UTC");
  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  const dateTimeText = useMemo(() => createDateTimeText(timeZone), [timeZone]);
  return { timeZone, dateTimeText };
}
