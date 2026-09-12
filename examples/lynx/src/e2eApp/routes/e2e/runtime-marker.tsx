import { createFileRoute } from "@tanstack/react-router";

import { RuntimeMarkerScreen } from "../../screens";

export const Route = createFileRoute("/e2e/runtime-marker")({
  component: RuntimeMarkerScreen,
});
