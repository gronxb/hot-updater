import type { IosDeviceStatus } from "@hot-updater/plugin-core";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  approveIosDevice,
  createIosDeviceProfileLink,
  getIosDevices,
  getNativeBuildIpaDevices,
  removeIosDevice,
  renameIosDevice,
  requestIosDeviceAccess,
} from "./ios-devices-rpc";

export const iosDeviceKeys = {
  all: ["ios-devices"] as const,
  list: (status?: IosDeviceStatus) => ["ios-devices", status ?? "all"] as const,
  ipa: (buildId: string) => ["native-build-ipa-devices", buildId] as const,
};

/**
 * How long a profile link is used before the page signs a new one: its
 * capability works 15 minutes, and a tester may leave the page open.
 */
export const PROFILE_LINK_REFRESH_MS = 10 * 60 * 1000;

/**
 * The registry, one status or all, kept on screen while it reloads, so a
 * filter change never blanks the table.
 */
export function useIosDevicesQuery(status?: IosDeviceStatus) {
  return useQuery({
    queryKey: iosDeviceKeys.list(status),
    queryFn: () =>
      getIosDevices({ data: status === undefined ? {} : { status } }),
    placeholderData: keepPreviousData,
  });
}

/**
 * A signed link to this iPhone's profile, signed again before it expires:
 * the link stays a plain `<a href>`, so nothing waits on a request when it is
 * tapped. The token signs its input, the name to register or the build to
 * return to, so it has no data while another input's token loads: keeping
 * the previous one would register the old name.
 */
export function useIosDeviceProfileLinkQuery(
  input:
    | { readonly mode: "register"; readonly name: string }
    | { readonly mode: "identify"; readonly buildId: string },
  enabled = true,
) {
  return useQuery({
    queryKey: ["ios-device-profile-link", input] as const,
    queryFn: () => createIosDeviceProfileLink({ data: input }),
    enabled,
    staleTime: PROFILE_LINK_REFRESH_MS,
    refetchInterval: PROFILE_LINK_REFRESH_MS,
  });
}

/** The devices an IPA lists, by registry name where it has one. */
export function useNativeBuildIpaDevicesQuery(buildId: string) {
  return useQuery({
    queryKey: iosDeviceKeys.ipa(buildId),
    queryFn: () => getNativeBuildIpaDevices({ data: { id: buildId } }),
  });
}

const useInvalidatingMutation = <TInput, TResult>(
  mutationFn: (input: TInput) => Promise<TResult>,
) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: iosDeviceKeys.all }),
        // A build page reads the registry row of a device it lacks.
        queryClient.invalidateQueries({
          queryKey: ["native-build-install-eligibility"],
        }),
      ]);
    },
  });
};

export const useApproveIosDeviceMutation = () =>
  useInvalidatingMutation((input: { id: string; name: string }) =>
    approveIosDevice({ data: input }),
  );

export const useRenameIosDeviceMutation = () =>
  useInvalidatingMutation((input: { id: string; name: string }) =>
    renameIosDevice({ data: input }),
  );

export const useRemoveIosDeviceMutation = () =>
  useInvalidatingMutation((input: { udid: string }) =>
    removeIosDevice({ data: input }),
  );

export const useRequestIosDeviceAccessMutation = () =>
  useInvalidatingMutation((input: { receipt: string; name: string }) =>
    requestIosDeviceAccess({ data: input }),
  );
