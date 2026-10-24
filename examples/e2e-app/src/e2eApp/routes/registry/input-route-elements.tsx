import { cohortInputRoute } from "../cohort-input-route";
import { runtimeChannelInputRoute } from "../runtime-channel-input-route";

export const inputRouteElements = [
  cohortInputRoute,
  runtimeChannelInputRoute,
] as const;
