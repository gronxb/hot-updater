import { channelActionResultRoute } from "../channel-action-result-route";
import { cohortActionResultRoute } from "../cohort-action-result-route";
import { updateActionResultRoute } from "../update-action-result-route";
import { updateStoreDownloadPathsRoute } from "../update-store-download-paths-route";
import { updateStoreDownloadedRoute } from "../update-store-downloaded-route";

export const resultRouteElements = [
  channelActionResultRoute,
  cohortActionResultRoute,
  updateActionResultRoute,
  updateStoreDownloadedRoute,
  updateStoreDownloadPathsRoute,
] as const;
