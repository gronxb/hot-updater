import { createFileRoute } from "@tanstack/react-router";

import { ReloadAppActionScreen } from "../../../screens";

export const Route = createFileRoute("/e2e/action/reload-app")({
  component: ReloadAppActionScreen,
});
