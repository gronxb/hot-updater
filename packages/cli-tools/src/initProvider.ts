import { getHotUpdaterEnvValue } from "./hotUpdaterEnv";
import { MissingInitInputsError } from "./initOptions";
import {
  AWS_AUTH_MODES,
  AWS_INIT_PROVIDER,
  AWS_REGION_VALUES,
  type AwsRegionValue,
  isAwsAuthMode,
  isAwsRegionValue,
} from "./initProviders/aws";
import { CLOUDFLARE_INIT_PROVIDER } from "./initProviders/cloudflare";
import {
  FIREBASE_INIT_PROVIDER,
  FIREBASE_REGION_VALUES,
  isFirebaseRegion,
} from "./initProviders/firebase";
import {
  isSupabaseFunctionName,
  isSupabaseRegion,
  SUPABASE_DATABASE_PASSWORD_PROJECT_ID_ENV_KEY,
  SUPABASE_INIT_PROVIDER,
  SUPABASE_REGION_VALUES,
  type SupabaseRegion,
} from "./initProviders/supabase";
import { p } from "./prompts";

export {
  AWS_AUTH_MODES,
  AWS_INIT_PROVIDER,
  AWS_REGION_VALUES,
  CLOUDFLARE_INIT_PROVIDER,
  FIREBASE_INIT_PROVIDER,
  FIREBASE_REGION_VALUES,
  isAwsAuthMode,
  isAwsRegionValue,
  isFirebaseRegion,
  isSupabaseFunctionName,
  isSupabaseRegion,
  SUPABASE_DATABASE_PASSWORD_PROJECT_ID_ENV_KEY,
  SUPABASE_INIT_PROVIDER,
  SUPABASE_REGION_VALUES,
};
export type { AwsRegionValue, SupabaseRegion };

export type InitProviderInputPersistence = "always" | "with-consent";

export type InitProviderInputDefinition = {
  readonly envKey: string;
  readonly help: string;
  readonly optional?: boolean;
  readonly persistence?: InitProviderInputPersistence;
  readonly prompt?: {
    readonly defaultValue?: string;
    readonly message: string;
    readonly placeholder?: string;
    readonly type: "confirm" | "password" | "select" | "text";
  };
  readonly requiredWhen?: (
    inputs: Readonly<Record<string, string | undefined>>,
  ) => boolean;
  readonly requirementHint?: string;
  readonly validate?: (value: string | undefined) => boolean;
};

type InitProviderInputsDefinition = Readonly<
  Record<string, InitProviderInputDefinition>
>;

export type InitProviderDefinition<
  TInputs extends InitProviderInputsDefinition = InitProviderInputsDefinition,
> = {
  readonly inputs: TInputs;
  readonly label: string;
};

export const defineInitProvider = <
  const TInputs extends InitProviderInputsDefinition,
>(
  provider: InitProviderDefinition<TInputs>,
): InitProviderDefinition<TInputs> => provider;

export const INIT_PROVIDER_DEFINITIONS = {
  cloudflare: CLOUDFLARE_INIT_PROVIDER,
  aws: AWS_INIT_PROVIDER,
  supabase: SUPABASE_INIT_PROVIDER,
  firebase: FIREBASE_INIT_PROVIDER,
} as const;

export type InitProvider = keyof typeof INIT_PROVIDER_DEFINITIONS;

export const isInitProvider = (
  value: string | undefined,
): value is InitProvider =>
  value !== undefined && Object.hasOwn(INIT_PROVIDER_DEFINITIONS, value);

export const INIT_PROVIDER_NAMES = Object.keys(
  INIT_PROVIDER_DEFINITIONS,
).filter(isInitProvider);

export const shouldAutoSelectOnlyInitResource = ({
  availableResourceCount,
  savedIdentifier,
}: {
  readonly availableResourceCount: number;
  readonly savedIdentifier?: string;
}) => savedIdentifier === undefined && availableResourceCount === 1;

export const resolveInitProviderInput = (
  env: Readonly<Record<string, string>>,
  input: InitProviderInputDefinition,
): string | undefined => getHotUpdaterEnvValue(env, input.envKey);

export const resolveInitProviderInputs = (
  env: Readonly<Record<string, string>>,
  provider: InitProviderDefinition,
): Readonly<Record<string, string | undefined>> =>
  Object.fromEntries(
    Object.entries(provider.inputs).map(([name, input]) => [
      name,
      resolveInitProviderInput(env, input),
    ]),
  );

export const getMissingInitProviderInputs = ({
  inputs,
  provider,
}: {
  readonly inputs: Readonly<Record<string, string | undefined>>;
  readonly provider: InitProviderDefinition;
}): readonly string[] =>
  Object.entries(provider.inputs)
    .filter(([name, input]) => {
      const required = input.requiredWhen
        ? input.requiredWhen(inputs)
        : !input.optional;
      const value = inputs[name];

      return required && (!value?.trim() || input.validate?.(value) === false);
    })
    .map(([, input]) => input.envKey);

export const assertInitProviderInputs = <
  TInputs extends InitProviderInputsDefinition,
>({
  inputs,
  provider,
  strict,
}: {
  readonly inputs: Readonly<Record<string, string | undefined>>;
  readonly provider: InitProviderDefinition<TInputs>;
  readonly strict?: boolean;
}): void => {
  if (!strict) {
    return;
  }

  const missingInputs = getMissingInitProviderInputs({ inputs, provider });
  if (missingInputs.length > 0) {
    throw new MissingInitInputsError(missingInputs);
  }
};

const hasNewConsentInput = <TInputs extends InitProviderInputsDefinition>(
  provider: InitProviderDefinition<TInputs>,
  inputs: Readonly<Record<string, string | undefined>>,
  existingEnv: Readonly<Record<string, string>>,
) =>
  Object.entries(provider.inputs).some(([name, input]) => {
    if (input.persistence !== "with-consent") {
      return false;
    }

    const value = inputs[name];
    return value !== undefined && value !== existingEnv[input.envKey]?.trim();
  });

export const confirmInitInputPersistence = async <
  TInputs extends InitProviderInputsDefinition,
>({
  existingEnv,
  inputs,
  nonInteractive,
  provider,
}: {
  readonly existingEnv: Readonly<Record<string, string>>;
  readonly inputs: Readonly<Record<string, string | undefined>>;
  readonly nonInteractive: boolean;
  readonly provider: InitProviderDefinition<TInputs>;
}): Promise<boolean> => {
  if (!hasNewConsentInput(provider, inputs, existingEnv)) {
    return true;
  }
  if (nonInteractive) {
    return false;
  }

  const confirmed = await p.confirm({
    message:
      "Save these init inputs to .env.hotupdater for future infrastructure updates?",
    initialValue: true,
  });
  if (p.isCancel(confirmed)) {
    process.exit(1);
  }
  if (!confirmed) {
    p.log.info(
      "Credential inputs were not saved; provide them again for future infrastructure updates.",
    );
  }
  return confirmed;
};

export const getInitProviderEnvVars = <
  TInputs extends InitProviderInputsDefinition,
>({
  includeConsentInputs,
  inputs,
  provider,
}: {
  readonly includeConsentInputs: boolean;
  readonly inputs: Readonly<Record<string, string | undefined>>;
  readonly provider: InitProviderDefinition<TInputs>;
}): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const [name, input] of Object.entries(provider.inputs)) {
    const value = inputs[name];
    if (
      value !== undefined &&
      (input.persistence !== "with-consent" || includeConsentInputs)
    ) {
      env[input.envKey] = value;
    }
  }

  return env;
};
