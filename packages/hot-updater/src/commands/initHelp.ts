import {
  type InfraTemplateInput,
  readInfraTemplateInputs,
} from "./infra/scaffold";
import { INIT_PROVIDER_NAMES, INIT_PROVIDER_PACKAGES } from "./initProviders";

const formatInput = ({
  envKey,
  help,
  optional,
  requirementHint,
}: InfraTemplateInput) => {
  const requirement = optional
    ? "optional"
    : requirementHint
      ? requirementHint
      : "required";
  return `  ${envKey}  ${help} (${requirement})`;
};

/**
 * Read when the help is shown. The provider packages aren't installed until
 * init installs one, so each provider's inputs come from the infrastructure
 * template this CLI's build recorded them in.
 */
export const initHelp = () =>
  [
    "",
    "Environment file replay:",
    "  Re-run init with saved values to reconcile provider infrastructure:",
    "  $ hot-updater init --provider aws --from-env-file .env.hotupdater",
    "",
    "  --from-env-file disables init prompts. A missing build or provider is",
    "  reported before init installs packages, and every missing provider",
    "  input once the provider package is installed, before any resource",
    "  changes. Interactive init asks once before saving credential inputs for",
    "  reuse.",
    "",
    "Provider inputs:",
    ...INIT_PROVIDER_NAMES.flatMap((providerName) => [
      `\n${providerName} (${INIT_PROVIDER_PACKAGES[providerName].label})`,
      ...readInfraTemplateInputs(providerName).map(formatInput),
    ]),
  ].join("\n");
