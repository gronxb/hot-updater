import {
  getInstallId as getNativeInstallId,
  getPersistedUserIdentity as getNativePersistedUserIdentity,
  setUser,
} from "../native.js";
import { HOT_UPDATER_SDK_VERSION as nativeSdkVersion } from "../sdkVersion.js";

export type PersistedUserIdentity = {
  userId?: string;
  username?: string;
};

type SetPersistedUserIdentityParams = {
  userId?: number | string | null;
  username?: string | null;
};

export const HOT_UPDATER_SDK_VERSION: string = nativeSdkVersion;

export const getInstallId = (): string => getNativeInstallId();

export const getPersistedUserIdentity = (): PersistedUserIdentity =>
  getNativePersistedUserIdentity();

export function setPersistedUserIdentity(
  params: SetPersistedUserIdentityParams,
): void;
export function setPersistedUserIdentity(params: null): void;
export function setPersistedUserIdentity(
  params: SetPersistedUserIdentityParams | null,
): void {
  if (params === null) {
    setUser(null);
    return;
  }
  setUser(params);
}
