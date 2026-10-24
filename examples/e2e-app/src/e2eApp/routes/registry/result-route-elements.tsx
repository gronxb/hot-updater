import { resultActionRouteElements } from "./result-action-route-elements";
import { resultStoreRouteElements } from "./result-store-route-elements";

export const resultRouteElements = [
  ...resultActionRouteElements,
  ...resultStoreRouteElements,
] as const;
