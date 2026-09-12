import { createFileRoute } from "@tanstack/react-router";

import { ReadyScreen } from "../../screens";

export const Route = createFileRoute("/e2e/ready")({
  component: ReadyScreen,
});
