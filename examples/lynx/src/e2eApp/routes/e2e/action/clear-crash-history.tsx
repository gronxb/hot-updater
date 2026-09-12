import { createFileRoute } from "@tanstack/react-router";

import { ClearCrashHistoryActionScreen } from "../../../screens";

export const Route = createFileRoute("/e2e/action/clear-crash-history")({
  component: ClearCrashHistoryActionScreen,
});
