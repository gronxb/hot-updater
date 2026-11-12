import type { IosDeviceRow, IosDeviceStatus } from "@hot-updater/plugin-core";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";

import {
  approveIosDevice,
  createIosDeviceProfileLink,
  getIosDevice,
  getIosDevices,
  getNativeBuildIpaDevices,
  removeIosDevice,
  renameIosDevice,
} from "./ios-devices-rpc";
import { releasePendingReceipt } from "./native-builds";

export const iosDeviceKeys = {
  all: ["ios-devices"] as const,
  list: (status?: IosDeviceStatus) => ["ios-devices", status ?? "all"] as const,
  device: (udid: string) => ["ios-devices", "device", udid] as const,
  // What the cookie names doesn't depend on the ID this page kept: one read
  // serves the page whether it knew its iPhone or learns it from the answer.
  kept: (receipt: string | null) =>
    ["ios-devices", "kept", receipt ?? ""] as const,
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

/** Told when a trade sets the cookie, so a cached "no proof" is read again. */
const KEPT_EVENT = "hot-updater-ios-device-kept";

/** Trades in flight or done, one per receipt: a failed one is forgotten. */
const trades = new Map<string, Promise<unknown>>();

/**
 * Trades the profile answer's fresh receipt for this Safari's HttpOnly cookie,
 * wherever the answer lands: whatever the build page or the registry says, the
 * proof is kept. One request per receipt while it is in flight or once it has
 * succeeded; a failed one rejects and is forgotten, so the next refresh,
 * refocus, or reload trades it again while it is still valid. Once traded,
 * the receipt leaves this tab's session storage.
 */
export const keepIosDeviceReceipt = (consolePath: string, receipt: string) => {
  let trade = trades.get(receipt);
  if (trade === undefined) {
    trade = sendDeviceRoute(deviceRoute(consolePath, "receipt"), {
      method: "POST",
      json: { receipt },
    }).then(
      (answer) => {
        releasePendingReceipt(receipt);
        window.dispatchEvent(new Event(KEPT_EVENT));
        return answer;
      },
      (error: unknown) => {
        trades.delete(receipt);
        throw error;
      },
    );
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
  receipt: string | null,
  enabled: boolean,
) {
  // A trade on this page sets the cookie the receiptless read may have found
  // empty: that read, cached for good otherwise, is read again.
  const queryClient = useQueryClient();
  useEffect(() => {
    const onKept = () =>
      void queryClient.invalidateQueries({
        queryKey: iosDeviceKeys.kept(null),
        exact: true,
      });
    window.addEventListener(KEPT_EVENT, onKept);
    return () => window.removeEventListener(KEPT_EVENT, onKept);
  }, [queryClient]);
  return useQuery({
    queryKey: iosDeviceKeys.kept(receipt),
    queryFn: async () => {
      let failed: unknown = null;
      if (receipt !== null) {
        await keepIosDeviceReceipt(consolePath, receipt).catch((error) => {
          failed = error;
        });
      }
      const kept = await sendDeviceRoute<{ udid: string | null }>(
        deviceRoute(consolePath, "receipt"),
      );
      // A trade that failed with no earlier proof leaves the read failed, so
      // the next refresh or refocus trades the receipt again; no timer does.
      if (failed !== null && kept.udid === null) throw failed;
      return kept;
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
