/**
 * Not a public API: what `@hot-updater/server`'s own Insights specs reach
 * past the plugin's entry for. It can change in any release.
 */
export { InsightsBadRequestError } from "./server/errors";
export { EVENT_BODY_MAX_BYTES } from "./server/eventInput";
export { INSIGHTS_ROUTES } from "./server/routes";
export { DAILY_EVENTS } from "./server/schema";
