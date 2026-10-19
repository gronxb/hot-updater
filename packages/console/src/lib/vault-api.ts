import type {
  VaultSecretKind,
  VaultTokenScope,
} from "@hot-updater/server/plugins";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getVaultStatusRpc,
  issueVaultTokenRpc,
  listVaultSecretsRpc,
  listVaultTokensRpc,
  putVaultSecretRpc,
  removeVaultSecretRpc,
  revokeVaultTokenRpc,
} from "./vault-rpc";

export const vaultQueryKeys = {
  status: ["vault", "status"] as const,
  secrets: ["vault", "secrets"] as const,
  tokens: ["vault", "tokens"] as const,
};

/** Whether the console holds a master key; it changes only with a redeploy. */
export const useVaultStatusQuery = () =>
  useQuery({
    queryKey: vaultQueryKeys.status,
    queryFn: () => getVaultStatusRpc(),
    staleTime: Infinity,
  });

/** The secrets without values, read once a visit unless a write changes them. */
export const useVaultSecretsQuery = () =>
  useQuery({
    queryKey: vaultQueryKeys.secrets,
    queryFn: () => listVaultSecretsRpc(),
    staleTime: 5 * 60_000,
  });

/** Vault tokens, newest first, revoked and expired ones too. */
export const useVaultTokensQuery = ({
  enabled = true,
}: { readonly enabled?: boolean } = {}) =>
  useQuery({
    queryKey: vaultQueryKeys.tokens,
    queryFn: () => listVaultTokensRpc(),
    staleTime: 5 * 60_000,
    enabled,
  });

export const usePutVaultSecretMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      readonly name: string;
      readonly kind: VaultSecretKind;
      readonly value: unknown;
      readonly overwrite: boolean;
    }) => putVaultSecretRpc({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: vaultQueryKeys.secrets });
    },
  });
};

export const useRemoveVaultSecretMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => removeVaultSecretRpc({ data: { id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: vaultQueryKeys.secrets });
    },
  });
};

export const useIssueVaultTokenMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      readonly name: string;
      readonly scope: VaultTokenScope;
      readonly expiresAtMs?: number;
    }) => issueVaultTokenRpc({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: vaultQueryKeys.tokens });
    },
  });
};

export const useRevokeVaultTokenMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeVaultTokenRpc({ data: { id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: vaultQueryKeys.tokens });
    },
  });
};
