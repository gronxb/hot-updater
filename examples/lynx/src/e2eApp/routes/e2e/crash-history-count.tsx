import { createFileRoute } from "@tanstack/react-router";

import { CrashHistoryCountScreen } from "../../screens";

export const Route = createFileRoute("/e2e/crash-history-count")({
  component: CrashHistoryCountScreen,
});
