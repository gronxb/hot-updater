import { withPublicBundleErrors } from "../utils/publicBundleError";
import {
  handleReleaseDelete,
  handleReleaseEnablement,
  handleReleaseList,
  handleReleasePreflight,
  handleReleaseShow,
  handleReleaseUpdate,
} from "./release";

export const handleBundleList = handleReleaseList;
export const handleBundleShow = handleReleaseShow;
export const handleBundleUpdate: typeof handleReleaseUpdate = (...args) =>
  withPublicBundleErrors(() => handleReleaseUpdate(...args));
export const handleBundlePreflight: typeof handleReleasePreflight = (...args) =>
  withPublicBundleErrors(() => handleReleasePreflight(...args));
export const handleBundleEnablement: typeof handleReleaseEnablement = (
  ...args
) => withPublicBundleErrors(() => handleReleaseEnablement(...args));
export const handleBundleDelete: typeof handleReleaseDelete = (...args) =>
  withPublicBundleErrors(() => handleReleaseDelete(...args));
