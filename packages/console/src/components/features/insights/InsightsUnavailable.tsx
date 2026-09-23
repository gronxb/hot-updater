import { Info } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** Insights is off: the server answers its routes with `x-hot-updater-insights: disabled`. */
export function InsightsOffBanner() {
  return (
    <Alert>
      <Info aria-hidden="true" />
      <AlertTitle>Insights is off</AlertTitle>
      <AlertDescription>
        The server runs without the insights() plugin, so it records no update
        events. Add insights() from @hot-updater/server/plugins/insights to
        plugins, where you create the server and in the console config, to turn
        it on.
      </AlertDescription>
    </Alert>
  );
}

/** A self-hosted server serves events and installations to the console, not usage or release activity. */
export function InsightsActivityUnavailable() {
  return (
    <Alert>
      <Info aria-hidden="true" />
      <AlertTitle>Usage is read from the database</AlertTitle>
      <AlertDescription>
        The console reads a self-hosted server's Insights through its admin API,
        which serves events and installations only. Open the console with the
        database config the server uses to see usage and bundle activity.
      </AlertDescription>
    </Alert>
  );
}
