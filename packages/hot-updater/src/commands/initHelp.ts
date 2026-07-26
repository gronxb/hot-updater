import {
  INIT_PROVIDER_DEFINITIONS,
  INIT_PROVIDER_NAMES,
} from "@hot-updater/cli-tools";

const formatInput = ({
  envKey,
  help,
  optional,
  requirementHint,
}: {
  readonly envKey: string;
  readonly help: string;
  readonly optional?: boolean;
  readonly requirementHint?: string;
}) => {
  const requirement = optional
    ? "optional"
    : requirementHint
      ? requirementHint
      : "required";
  return `  ${envKey}  ${help} (${requirement})`;
};

export const initHelp = [
  "",
  "Environment file replay:",
  "  Re-run init with saved values to reconcile provider infrastructure:",
  "  $ hot-updater init --provider aws --env-file .env.hotupdater",
  "",
  "  --env-file disables init prompts and reports every missing value.",
  "  Interactive init asks once before saving credential inputs for reuse.",
  "",
  "Provider inputs:",
  ...INIT_PROVIDER_NAMES.flatMap((providerName) => {
    const provider = INIT_PROVIDER_DEFINITIONS[providerName];
    return [
      `\n${providerName} (${provider.label})`,
      ...Object.values(provider.inputs).map(formatInput),
    ];
  }),
].join("\n");
