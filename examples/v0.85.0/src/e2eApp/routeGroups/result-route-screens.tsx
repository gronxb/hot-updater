import { channelActionResultRouteScreen } from "./channel-action-result-route-screen";
import { cohortActionResultRouteScreen } from "./cohort-action-result-route-screen";
import { updateActionResultRouteScreen } from "./update-action-result-route-screen";

export const resultRouteScreens = [
  channelActionResultRouteScreen,
  updateActionResultRouteScreen,
  cohortActionResultRouteScreen,
] as const;
