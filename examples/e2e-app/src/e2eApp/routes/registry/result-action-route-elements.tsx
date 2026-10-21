import { channelActionResultRoute } from "../channel-action-result-route";
import { cohortActionResultRoute } from "../cohort-action-result-route";
import { updateActionResultRoute } from "../update-action-result-route";

export const resultActionRouteElements = [
  channelActionResultRoute,
  cohortActionResultRoute,
  updateActionResultRoute,
] as const;
