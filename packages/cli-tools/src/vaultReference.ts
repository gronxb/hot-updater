/** A vault secret's name, as the vault takes one. */
const VAULT_REFERENCE_PATTERN = /^vault:([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u;

/**
 * The secret name a config's `vault:<name>` reference names, such as
 * `release-keystore` for `"vault:release-keystore"`. `field` is the config
 * field the reference is in, which the error names.
 */
export const parseVaultReference = (reference: string, field: string) => {
  const name = VAULT_REFERENCE_PATTERN.exec(reference)?.[1];
  if (name === undefined) {
    throw new Error(
      `${field} names a vault secret as vault:<name>, such as "vault:release-keystore", and ${JSON.stringify(reference)} is not one.`,
    );
  }
  return name;
};
