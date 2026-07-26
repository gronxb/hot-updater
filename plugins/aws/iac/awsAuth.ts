import {
  fromIni,
  fromNodeProviderChain,
  fromSSO,
} from "@aws-sdk/credential-providers";
import {
  AWS_INIT_PROVIDER,
  MissingInitInputsError,
  p,
  resolveInitProviderInput,
} from "@hot-updater/cli-tools";
import { ExecaError, execa } from "execa";

import { type AwsAuthMode, isAwsAuthMode } from "./awsInitInputs";
import type { AwsConfigScaffoldAuthMode } from "./templates";

type AwsCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
};

export type ResolvedAwsAuth = {
  readonly awsProfile: string | null;
  readonly configAuthMode: AwsConfigScaffoldAuthMode;
  readonly credentials: AwsCredentials;
  readonly mode: AwsAuthMode;
};

const exitWithCredentialError = (error: Error): never => {
  if (error instanceof ExecaError) {
    p.log.error(error.stdout || error.stderr || error.message);
  } else {
    p.log.error(error.message);
  }
  process.exit(1);
};

export const resolveAwsAuth = async (
  existingEnv: Readonly<Record<string, string>>,
  nonInteractive = false,
): Promise<ResolvedAwsAuth> => {
  const inputDefinitions = AWS_INIT_PROVIDER.inputs;
  const savedMode = resolveInitProviderInput(
    existingEnv,
    inputDefinitions.authMode,
  );
  const mode = isAwsAuthMode(savedMode) ? savedMode : undefined;
  const savedProfile = resolveInitProviderInput(
    existingEnv,
    inputDefinitions.profile,
  );
  const savedAccessKeyId = resolveInitProviderInput(
    existingEnv,
    inputDefinitions.accessKeyId,
  );
  const savedSecretAccessKey = resolveInitProviderInput(
    existingEnv,
    inputDefinitions.secretAccessKey,
  );

  if (mode === "account" && savedAccessKeyId && savedSecretAccessKey) {
    return {
      awsProfile: null,
      configAuthMode: { mode: "account" },
      credentials: {
        accessKeyId: savedAccessKeyId,
        secretAccessKey: savedSecretAccessKey,
      },
      mode,
    };
  }

  const inputs = await p.group<{
    mode: AwsAuthMode | symbol;
    profile: string | symbol | undefined;
    accessKeyId: string | symbol | undefined;
    secretAccessKey: string | symbol | undefined;
  }>(
    {
      mode: () =>
        mode
          ? Promise.resolve(mode)
          : p.select<AwsAuthMode>({
              message: inputDefinitions.authMode.prompt.message,
              options: [
                {
                  label: "Current AWS CLI Session / Default Credential Chain",
                  value: "local-session",
                },
                { label: "Shared AWS Profile", value: "shared-profile" },
                { label: "AWS SSO Login", value: "sso" },
                {
                  label: "AWS Access Key ID & Secret Access Key",
                  value: "account",
                },
              ],
            }),
      profile: ({ results }) => {
        if (results.mode !== "shared-profile" && results.mode !== "sso") {
          return Promise.resolve(undefined);
        }
        if (savedProfile) {
          return Promise.resolve(savedProfile);
        }
        return p.text({
          message: inputDefinitions.profile.prompt.message,
          defaultValue:
            process.env.AWS_PROFILE ??
            inputDefinitions.profile.prompt.defaultValue,
          placeholder:
            process.env.AWS_PROFILE ??
            inputDefinitions.profile.prompt.placeholder,
          validate: (value) =>
            (value ?? "").trim() ? undefined : "AWS profile name is required",
        });
      },
      accessKeyId: ({ results }) => {
        if (results.mode !== "account") {
          return Promise.resolve(undefined);
        }
        if (savedAccessKeyId) {
          return Promise.resolve(savedAccessKeyId);
        }
        return p.text({
          message: inputDefinitions.accessKeyId.prompt.message,
          validate: (value) =>
            value ? undefined : "Access Key ID is required",
        });
      },
      secretAccessKey: ({ results }) => {
        if (results.mode !== "account") {
          return Promise.resolve(undefined);
        }
        if (savedSecretAccessKey) {
          return Promise.resolve(savedSecretAccessKey);
        }
        return p.password({
          message: inputDefinitions.secretAccessKey.prompt.message,
          validate: (value) =>
            value ? undefined : "Secret Access Key is required",
        });
      },
    },
    {
      onCancel: () => process.exit(1),
    },
  );

  switch (inputs.mode) {
    case "account": {
      if (!inputs.accessKeyId || !inputs.secretAccessKey) {
        p.log.error("AWS access key credentials are required.");
        process.exit(1);
      }
      return {
        awsProfile: null,
        configAuthMode: { mode: "account" },
        credentials: {
          accessKeyId: inputs.accessKeyId,
          secretAccessKey: inputs.secretAccessKey,
        },
        mode: inputs.mode,
      };
    }
    case "local-session": {
      try {
        return {
          awsProfile: null,
          configAuthMode: { mode: "local", profile: null },
          credentials: await fromNodeProviderChain()(),
          mode: inputs.mode,
        };
      } catch (error) {
        if (error instanceof Error) {
          return exitWithCredentialError(error);
        }
        throw error;
      }
    }
    case "shared-profile": {
      if (!inputs.profile) {
        p.log.error("AWS profile is required.");
        process.exit(1);
      }
      const profile = inputs.profile.trim();
      try {
        return {
          awsProfile: profile,
          configAuthMode: { mode: "local", profile },
          credentials: await fromIni({ profile })(),
          mode: inputs.mode,
        };
      } catch (error) {
        if (error instanceof Error) {
          return exitWithCredentialError(error);
        }
        throw error;
      }
    }
    case "sso": {
      if (!inputs.profile) {
        p.log.error("AWS SSO profile is required.");
        process.exit(1);
      }
      const profile = inputs.profile.trim();
      try {
        let credentials: AwsCredentials;
        try {
          credentials = await fromSSO({ profile })();
        } catch {
          if (nonInteractive) {
            throw new MissingInitInputsError([
              "active AWS SSO session (`aws sso login`)",
            ]);
          }
          await execa("aws", ["sso", "login", "--profile", profile], {
            stdio: "inherit",
          });
          credentials = await fromSSO({ profile })();
        }
        return {
          awsProfile: profile,
          configAuthMode: { mode: "sso", profile },
          credentials,
          mode: inputs.mode,
        };
      } catch (error) {
        if (error instanceof MissingInitInputsError) {
          throw error;
        }
        if (error instanceof Error) {
          return exitWithCredentialError(error);
        }
        throw error;
      }
    }
  }
};
