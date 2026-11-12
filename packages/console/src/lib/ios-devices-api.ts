import type { IosDeviceRow, IosDeviceStatus } from "@hot-updater/plugin-core";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  approveIosDevice,
  createIosDeviceProfileLink,
  getIosDevice,
  getIosDevices,
  getNativeBuildIpaDevices,
  removeIosDevice,
  renameIosDevice,
} from "./ios-devices-rpc";

export const iosDeviceKeys = {
  all: ["ios-devices"] as const,
  list: (status?: IosDeviceStatus) => ["ios-devices", status ?? "all"] as const,
  device: (udid: string) => ["ios-devices", "device", udid] as const,
  kept: (udid: string, receipt: string | null) =>
    ["ios-devices", "kept", udid, receipt ?? ""] as const,
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
 * This iPhone's registry row, by the UDID its profile reported, or null once
 * it's gone; nothing is read without a UDID. Under `iosDeviceKeys.all`, so
 * an approval or a removal reads it again.
 */
export function useIosDeviceQuery(udid: string | null) {
  return useQuery({
    queryKey: iosDeviceKeys.device(udid ?? ""),
    queryFn: () => getIosDevice({ data: { udid: udid! } }),
    enabled: udid !== null,
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

/** The routes this iPhone's kept proof is sent to, under the Console's path. */
const deviceRoute = (consolePath: string, name: "receipt" | "request") =>
  `${consolePath}/_hot-updater/devices/${name}`;

const sendDeviceRoute = async <T>(
  url: string,
  init: RequestInit & { readonly json?: unknown } = {},
): Promise<T> => {
  const { json, ...rest } = init;
  const response = await fetch(url, {
    credentials: "same-origin",
    ...rest,
    ...(json === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(json),
        }),
  });
  const body = (await response.json().catch(() => null)) as
    | (T & { readonly error?: string })
    | null;
  if (!response.ok || body === null) {
    throw new Error(body?.error ?? `Request failed (${response.status}).`);
  }
  return body;
};

/** Trades in flight or done, one per receipt. */
const trades = new Map<string, Promise<unknown>>();

/**
 * Trades the profile answer's fresh receipt for this Safari's HttpOnly cookie,
 * once per receipt, wherever the answer lands: whatever the build page or the
 * registry says, the proof is kept. A failed trade leaves the receipt in
 * memory for this page.
 */
export const keepIosDeviceReceipt = (consolePath: string, receipt: string) => {
  let trade = trades.get(receipt);
  if (trade === undefined) {
    trade = sendDeviceRoute(deviceRoute(consolePath, "receipt"), {
      method: "POST",
      json: { receipt },
    }).catch(() => null);
    trades.set(receipt, trade);
  }
  return trade;
};

/**
 * The UDID this Safari has proved for the signed-in person, from its HttpOnly
 * cookie, or null, read after the page's fresh receipt, if any, is traded for
 * it. Read on an iPhone only.
 */
export function useKeptIosDeviceQuery(
  consolePath: string,
  device: { readonly udid: string | null; readonly receipt: string | null },
  enabled: boolean,
) {
  const { receipt } = device;
  return useQuery({
    queryKey: iosDeviceKeys.kept(device.udid ?? "", receipt),
    queryFn: async () => {
      if (receipt !== null) await keepIosDeviceReceipt(consolePath, receipt);
      return sendDeviceRoute<{ udid: string | null }>(
        deviceRoute(consolePath, "receipt"),
      );
    },
    enabled,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Forgets this Safari's proof of its iPhone before sign-out, so the next
 * person on this Safari starts from the profile. Only an iPhone or iPad holds
 * one; a failure leaves the cookie, which the next email ignores anyway.
 */
export const forgetKeptIosDevice = async (consolePath: string) => {
  await sendDeviceRoute(deviceRoute(consolePath, "receipt"), {
    method: "DELETE",
  }).catch(() => undefined);
};

/**
 * Requests this iPhone for the signed-in person, under `name`: the UDID comes
 * from the profile's fresh receipt when the page has one, else from the
 * cookie that proved it before.
 */
export const useRequestThisIphoneMutation = (consolePath: string) =>
  useInvalidatingMutation(
    (input: { readonly name: string; readonly receipt: string | null }) =>
      sendDeviceRoute<{ device: IosDeviceRow; created: boolean }>(
        deviceRoute(consolePath, "request"),
        {
          method: "POST",
          json:
            input.receipt === null
              ? { name: input.name }
              : { name: input.name, receipt: input.receipt },
        },
      ),
  );

/** Whether the cookie's UDID is this iPhone's, whatever its case. */
export const keptIsThisIphone = (
  kept: string | null | undefined,
  udid: string | null,
) => kept != null && udid !== null && kept.toLowerCase() === udid.toLowerCase();
