import type { ConsoleSigningConfig } from "../../index";

const DEFAULT_PROVIDER = "Configured provider";

export type BundleSigningInspection =
  | { readonly status: "disabled" }
  | {
      readonly status: "enabled";
      readonly provider: string;
      readonly algorithm: "RSA-SHA256";
    };

export const inspectBundleSigning = async (
  signing: ConsoleSigningConfig | undefined,
): Promise<BundleSigningInspection> => {
  if (!signing?.enabled) return { status: "disabled" };

  return {
    algorithm: "RSA-SHA256",
    provider: signing.provider ?? DEFAULT_PROVIDER,
    status: "enabled",
  };
};
