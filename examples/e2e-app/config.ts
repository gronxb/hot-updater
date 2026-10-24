// The E2E settings a second runtime (the brownfield widget) reads, without
// the main app: importing the package root starts the main instance.
export { HOT_UPDATER_API_KEY } from "./src/e2eBuildConfig";
export {
  patchE2eScreenState,
  resolveHotUpdaterBaseURL,
} from "./src/e2eRuntimeConfig";
