import { updateStoreDownloadPathsRoute } from "../update-store-download-paths-route";
import { updateStoreDownloadedRoute } from "../update-store-downloaded-route";

export const resultStoreRouteElements = [
  updateStoreDownloadedRoute,
  updateStoreDownloadPathsRoute,
] as const;
