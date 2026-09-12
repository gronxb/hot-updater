import { createFileRoute } from "@tanstack/react-router";

import { ReadyScreen } from "../screens";

export const Route = createFileRoute("/")({
  component: ReadyScreen,
});
