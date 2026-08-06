import {
  assertInitInputs,
  assertInitProviderInputs,
  getInitProviderTextPromptValues,
  p,
} from "@hot-updater/cli-tools";

import {
  initProvider as SUPABASE_INIT_PROVIDER,
  isSupabaseFunctionName,
} from "./init/index";
import {
  hasValidSupabaseCliLogin,
  inputSupabaseAccessToken,
} from "./supabaseAuthentication";
import type { SupabaseInitInputs } from "./supabaseInitInputs";

type SupabaseCliLoginValidator = () => Promise<boolean>;

export const assertSupabaseNonInteractiveInputs = async (
  inputs: SupabaseInitInputs,
  nonInteractive: boolean,
  validateCliLogin: SupabaseCliLoginValidator = hasValidSupabaseCliLogin,
): Promise<void> => {
  const cliLoginValid =
    nonInteractive &&
    inputs.accessToken === undefined &&
    (await validateCliLogin());

  assertInitProviderInputs({
    inputs: cliLoginValid
      ? { ...inputs, accessToken: "supabase-cli-login" }
      : inputs,
    provider: SUPABASE_INIT_PROVIDER,
    strict: nonInteractive,
  });
};

export const inputSupabaseDeploymentInputs = async ({
  accessToken,
  functionName,
  nonInteractive,
}: SupabaseInitInputs & {
  readonly nonInteractive: boolean;
}): Promise<{
  readonly accessToken?: string;
  readonly functionName: string;
}> => {
  const { inputs } = SUPABASE_INIT_PROVIDER;
  assertInitInputs({
    inputs: {
      [inputs.functionName.envKey]: functionName,
    },
    strict: nonInteractive,
  });

  if (nonInteractive && functionName) {
    return {
      accessToken,
      functionName,
    };
  }

  const savedFunctionName = isSupabaseFunctionName(functionName)
    ? functionName
    : undefined;

  return p.group(
    {
      accessToken: () =>
        nonInteractive && accessToken
          ? Promise.resolve(accessToken)
          : inputSupabaseAccessToken(),
      functionName: () =>
        nonInteractive && savedFunctionName
          ? Promise.resolve(savedFunctionName)
          : p.text({
              ...getInitProviderTextPromptValues(
                inputs.functionName.prompt,
                savedFunctionName,
              ),
              message: inputs.functionName.prompt.message,
              validate: (value) =>
                isSupabaseFunctionName(value)
                  ? undefined
                  : "Start with a letter and use only letters, numbers, underscores, or hyphens",
            }),
    },
    {
      onCancel: () => process.exit(0),
    },
  );
};
