import { definePlugin } from "@hot-updater/plugin-core";

import { createRemoteConfigApi } from "./api";
import { markOfficial } from "./official";
import { createRemoteConfigEndpoints } from "./routes";
import { remoteConfigSchema } from "./schema";

export type {
  RemoteConfigActive,
  RemoteConfigApi,
  RemoteConfigPublishResult,
  RemoteConfigVersion,
  RemoteConfigVersionDetail,
  RemoteConfigVersionsPage,
} from "./api";
export { remoteConfigSchema, type RemoteConfigSchema } from "./schema";
export {
  EMPTY_REMOTE_CONFIG_TEMPLATE,
  evaluateRemoteConfig,
  matchesRemoteConfigCondition,
  matchesRemoteConfigRule,
  REMOTE_CONFIG_MAX_CONDITIONS,
  REMOTE_CONFIG_MAX_PARAMETERS,
  REMOTE_CONFIG_MAX_TEMPLATE_LENGTH,
  type RemoteConfigCondition,
  type RemoteConfigEvaluatedParameter,
  type RemoteConfigEvaluationContext,
  type RemoteConfigParameter,
  type RemoteConfigParameterValue,
  type RemoteConfigRule,
  type RemoteConfigRuleType,
  type RemoteConfigTemplate,
  type RemoteConfigTemplateIssue,
  RemoteConfigValidationError,
  type RemoteConfigValueType,
  resolveRemoteConfigValues,
  validateRemoteConfigTemplate,
} from "./template";
export type {
  RemoteConfigDeviceContext,
  RemoteConfigFetchResponse,
} from "../shared/wire";

/**
 * Remote Config: parameters whose values the server picks per device by
 * conditions, published as versioned templates, as Firebase Remote Config
 * does. Devices fetch their values from `GET /remote-config` with the
 * `remoteConfig()` client plugin; the Console and `hotUpdater.api.remoteConfig`
 * edit, publish, and roll back templates.
 */
export const remoteConfig = () => {
  const plugin = definePlugin({
    id: "remoteConfig",
    // Keeps its tables' names, remote_config_*, and with them the camelCase id.
    namespace: false,
    schemaVersion: "1.0.0",
    schema: remoteConfigSchema,
    init: ({ db, now }) => {
      const api = createRemoteConfigApi({ db, now });
      return { api, endpoints: createRemoteConfigEndpoints(api) };
    },
  });
  // Only this factory may take the id; tooling and the console tell it by the mark.
  return markOfficial(plugin);
};
