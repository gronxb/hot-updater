import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { p, registerSecretValue } from "@hot-updater/cli-tools";

import {
  ASC_INTEGRATIONS_URL,
  type AscTeam,
  type IssueAscApiKey,
  type IssuedAscApiKey,
} from "../ascApiKey";
import {
  AppleSignInError,
  type AppleProvider,
  type AppleSignInPrompts,
  type TwoFactorCodeRequest,
  type AppleWebSession,
  signInToAppStoreConnect,
} from "./appleSignIn";

const IRIS_URL = "https://appstoreconnect.apple.com/iris/v1";

/**
 * The headers App Store Connect's Integrations page sends its API with. A
 * function: `ascApiKey` imports this module, so its constants aren't set
 * yet when this module loads.
 */
const irisHeaders = () => ({
  Accept: "application/vnd.api+json, application/json, text/csv",
  "Content-Type": "application/json",
  "X-CSRF-ITC": "[asc-ui]",
  Origin: "https://appstoreconnect.apple.com",
  Referer: ASC_INTEGRATIONS_URL,
});

const answer = (value: string | symbol) =>
  p.isCancel(value) ? undefined : value;

/** One line: where the code went, and where a wrong one sends the next. */
export const twoFactorMessage = (request: TwoFactorCodeRequest) => {
  const phone = request.destination ?? "your trusted phone";
  if (request.via === "sms") {
    return `${request.afterWrongCode ? "Wrong code. " : ""}Code texted to ${phone}`;
  }
  return request.textsOnWrongCode
    ? `Code on your Apple device (wrong code texts ${phone})`
    : "Code on your Apple device";
};

/** Hot Updater's own prompts, so the sign-in looks like the rest of the CLI. */
const cliPrompts: AppleSignInPrompts = {
  password: async (appleId) =>
    answer(
      await p.password({
        message: appleId ? `Password of ${appleId}` : "Apple Account password",
        mask: "•",
        validate: (value) => (value ? undefined : "Enter the password."),
      }),
    ),
  twoFactorCode: async (request) =>
    answer(
      await p.text({
        message: twoFactorMessage(request),
        validate: (value) =>
          new RegExp(`^\\d{${request.length}}$`, "u").test(value?.trim() ?? "")
            ? undefined
            : `Enter the ${request.length}-digit code.`,
      }),
    )?.trim(),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const toTeam = (appleId: string, provider: AppleProvider): AscTeam => ({
  appleId,
  teamId: provider.publicProviderId,
  ...(provider.name ? { name: provider.name } : {}),
});

/** What App Store Connect's API said went wrong, from its JSON:API errors. */
const irisDetail = (body: string) => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !Array.isArray(parsed.errors)) return undefined;
    return parsed.errors
      .filter(isRecord)
      .map((error) => text(error.detail) ?? text(error.title))
      .find(Boolean);
  } catch {
    return undefined;
  }
};

/** What to do about a key App Store Connect would not create. */
const createFailureHint = (status: number, body: string) => {
  if (/agreement/iu.test(body)) {
    return "The Account Holder must accept the new Apple Developer Program License\nAgreement at https://developer.apple.com/account, then run this again.";
  }
  if (/limit|maximum/iu.test(body)) {
    return `The team has the most API keys App Store Connect allows. Revoke one at:\n${ASC_INTEGRATIONS_URL}`;
  }
  if (status === 403 || /account holder|admin|permission/iu.test(body)) {
    return "Creating an API key needs the Account Holder or Admin role in the team.";
  }
  return undefined;
};

const irisRequest = async (
  session: AppleWebSession,
  step: string,
  method: string,
  path: string,
  payload?: unknown,
) => {
  const response = await session.request(`${IRIS_URL}${path}`, {
    method,
    headers: irisHeaders(),
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const body = await response.text();
  if (!response.ok) {
    const detail = irisDetail(body);
    throw new AppleSignInError(
      `${step} failed (HTTP ${response.status}).${detail ? `\n${detail}` : ""}`,
      { status: response.status, body },
    );
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed.data)) return parsed.data;
  } catch {}
  throw new AppleSignInError(`${step} answered no API key.`, {
    status: response.status,
  });
};

/** A P-256 private key, as App Store Connect issues one, or a thrown error. */
const assertP8 = (p8: string) => {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(p8);
  } catch {
    throw new Error("App Store Connect sent a .p8 that is not a private key.");
  }
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error(
      "App Store Connect sent a .p8 that is not a P-256 private key.",
    );
  }
};

/** The one-time `.p8`; a key App Store Connect hasn't settled yet is retried. */
const downloadP8 = async (
  session: AppleWebSession,
  keyId: string,
  wait: (ms: number) => Promise<unknown>,
) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const data = await irisRequest(
        session,
        "Downloading the key's .p8",
        "GET",
        `/apiKeys/${encodeURIComponent(keyId)}?${new URLSearchParams({ "fields[apiKeys]": "privateKey" })}`,
      );
      const encoded = isRecord(data.attributes)
        ? text(data.attributes.privateKey)
        : undefined;
      if (text(data.id) !== keyId || !encoded) {
        throw new Error("App Store Connect sent no .p8 for the key.");
      }
      return Buffer.from(encoded, "base64").toString("utf-8").trim();
    } catch (error) {
      // Only an error status proves the one-time .p8 was not sent.
      const retryable =
        error instanceof AppleSignInError &&
        error.status !== undefined &&
        (error.status === 404 ||
          error.status === 409 ||
          error.status === 429 ||
          error.status >= 500);
      if (!retryable || attempt === 3) throw error;
      await wait(attempt * 1000);
    }
  }
};

const issuerOf = (data: Record<string, unknown>) => {
  const attributes = isRecord(data.attributes) ? data.attributes : {};
  const relationships = isRecord(data.relationships) ? data.relationships : {};
  const related = isRecord(relationships.provider)
    ? relationships.provider.data
    : undefined;
  return (
    (isRecord(attributes.provider)
      ? text(attributes.provider.id)
      : undefined) ?? (isRecord(related) ? text(related.id) : undefined)
  );
};

/**
 * `IssueAscApiKey` by signing in as App Store Connect's web page does
 * (`signInToAppStoreConnect`) and creating the key with the API its
 * Integrations page uses:
 *
 * 1. The password typed into Hot Updater's prompt goes only to Apple's SRP
 *    sign-in, which sends a proof of it, never the password; the two-factor
 *    code goes only to Apple's check. Neither is kept or printed.
 * 2. `chooseTeam` sees the teams the Apple Account is in, unless `teamId`
 *    is set.
 * 3. The key is created, its one-time `.p8` downloaded and checked; a key
 *    that fails the check is revoked at once.
 * 4. `revoke` deactivates the key in the same session.
 *
 * The session is cookies in this process's memory, which `dispose` drops.
 *
 * @param fetch Where requests go, Apple unless set.
 * @param prompts Where the password and two-factor codes are asked.
 * @param wait How a retried download waits.
 */
export const createAscKeyIssuer =
  ({
    fetch = globalThis.fetch,
    prompts = cliPrompts,
    wait = sleep,
  }: {
    fetch?: typeof globalThis.fetch;
    prompts?: AppleSignInPrompts;
    wait?: (ms: number) => Promise<unknown>;
  } = {}): IssueAscApiKey =>
  async ({ name, role, appleId, teamId, chooseTeam }) => {
    if (!appleId) {
      throw new AppleSignInError("Signing in needs the Apple Account's email.");
    }
    p.log.info("Signing in to App Store Connect. Only the issued key is kept.");
    const password = await prompts.password(appleId);
    if (password === undefined) {
      throw new AppleSignInError("Signing in was cancelled.");
    }
    registerSecretValue(password);
    const session = await signInToAppStoreConnect({
      appleId,
      password,
      prompts,
      fetch,
    });
    let disposed = false;
    const dispose = async () => {
      disposed = true;
      session.clear();
    };

    try {
      const teams = session.providers.map((provider) =>
        toTeam(appleId, provider),
      );
      const chosen =
        teamId ??
        (await chooseTeam?.(teams, toTeam(appleId, session.provider)));
      const provider =
        chosen === undefined
          ? session.provider
          : await session.selectProvider(chosen);

      let data: Record<string, unknown>;
      try {
        data = await irisRequest(
          session,
          "Creating the App Store Connect API key",
          "POST",
          "/apiKeys",
          {
            data: {
              type: "apiKeys",
              attributes: {
                nickname: name,
                roles: [role],
                allAppsVisible: true,
                keyType: "PUBLIC_API",
              },
            },
          },
        );
      } catch (error) {
        const hint =
          error instanceof AppleSignInError && error.status !== undefined
            ? createFailureHint(error.status, error.body ?? "")
            : undefined;
        if (hint) {
          throw new AppleSignInError(`${(error as Error).message}\n${hint}`, {
            ...((error as AppleSignInError).status === undefined
              ? {}
              : { status: (error as AppleSignInError).status }),
            cause: error,
          });
        }
        throw error;
      }
      const keyId = text(data.id);
      if (!keyId) {
        throw new AppleSignInError(
          "App Store Connect created a key without an ID.",
        );
      }

      const revoke = async () => {
        if (disposed) return false;
        return irisRequest(
          session,
          "Revoking the key",
          "PATCH",
          `/apiKeys/${encodeURIComponent(keyId)}`,
          {
            data: {
              id: keyId,
              type: "apiKeys",
              attributes: { isActive: false },
            },
          },
        ).then(
          () => true,
          () => false,
        );
      };

      let p8: string;
      let issuerId: string;
      try {
        p8 = await downloadP8(session, keyId, wait);
        registerSecretValue(p8);
        registerSecretValue(Buffer.from(p8).toString("base64"));
        assertP8(p8);
        const details = await irisRequest(
          session,
          "Reading the key's issuer ID",
          "GET",
          `/apiKeys/${encodeURIComponent(keyId)}?include=provider`,
        );
        const issuer = issuerOf(details) ?? issuerOf(data);
        if (!issuer) {
          throw new Error("App Store Connect named no issuer ID for the key.");
        }
        issuerId = issuer;
      } catch (error) {
        // A key nothing can use is not handed out, and not left behind.
        const revoked = await revoke();
        throw new Error(
          revoked
            ? `${(error as Error).message} The App Store Connect API key ${keyId} was revoked again.`
            : `${(error as Error).message} Revoking the App Store Connect API key ${keyId} failed too: revoke it at ${ASC_INTEGRATIONS_URL}.`,
          { cause: error },
        );
      }

      const issued: IssuedAscApiKey = {
        p8,
        keyId,
        issuerId,
        name:
          text(isRecord(data.attributes) ? data.attributes.nickname : "") ??
          name,
        team: toTeam(appleId, provider),
        revoke,
        dispose,
      };
      return issued;
    } catch (error) {
      await dispose();
      throw error;
    }
  };
