import React from "react";

import { appActionRoutes } from "./routes/app-action-routes";
import { cohortActionRoutes } from "./routes/cohort-action-routes";
import { inputRoutes } from "./routes/input-routes";
import { installActionRoutes } from "./routes/install-action-routes";
import { readyRoutes } from "./routes/ready-routes";
import { runtimeActionRoutes } from "./routes/runtime-action-routes";
import { runtimeBundleRoutes } from "./routes/runtime-bundle-routes";
import { runtimeChannelRoutes } from "./routes/runtime-channel-routes";
import { runtimeCohortRoutes } from "./routes/runtime-cohort-routes";
import { statusLaunchRoutes } from "./routes/status-launch-routes";
import { statusResultRoutes } from "./routes/status-result-routes";
import { statusUpdateStoreRoutes } from "./routes/status-update-store-routes";

export const registeredRouteElements = (
  <>
    {readyRoutes}
    {runtimeBundleRoutes}
    {runtimeChannelRoutes}
    {runtimeCohortRoutes}
    {statusLaunchRoutes}
    {statusResultRoutes}
    {statusUpdateStoreRoutes}
    {inputRoutes}
    {installActionRoutes}
    {cohortActionRoutes}
    {runtimeActionRoutes}
    {appActionRoutes}
  </>
);
