import path from "node:path";

import {
  checkPlayAccess,
  type PlayAccess,
  playConsoleInviteUrl,
} from "@hot-updater/android-helper";
import {
  type CredentialRequest,
  type CredentialResolver,
  type Credentials,
  CredentialUnavailableError,
  credentialPutCommand,
  registerCredentialValue,
} from "@hot-updater/cli-tools";

import { ui } from "../cli-ui";

/** The docs section that sets up Google Play: the key, the invite, the first .aab. */
export const GOOGLE_PLAY_GUIDE_URL =
  "https://hot-updater.dev/docs/native-builds/google-play#set-up-google-play";

/**
 * The least Play Console permission the service account needs: the CLI
 * releases only to the internal testing track.
 */
export const PLAY_PERMISSION = "Release apps to testing tracks";

/** A service account's JSON key file, read and checked. */
export interface ServiceAccountKey {
  /** The file's contents, stored as they are. */
  readonly json: string;
  /** `client_email`: the Play Console user it acts as. */
  readonly email: string;
  /** `private_key_id`, as Google Cloud lists it under the account's keys. */
  readonly keyId?: string;
}

const stringField = (fields: Record<string, unknown>, field: string) => {
  const value = fields[field];
  return typeof value === "string" && value ? value : undefined;
};

/**
 * Reads `text`, the contents of `file`, as a service account's JSON key:
 * `type: "service_account"` with a `private_key` and a `client_email`.
 * The private key is masked before anything can print it. Firebase's
 * `google-services.json`, the file people pick by mistake, is named.
 */
export const parseServiceAccountKey = (
  text: string,
  file: string,
): ServiceAccountKey => {
  const name = path.basename(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} is not a JSON key file.`);
  }
  const fields = parsed as Record<string, unknown>;
  const privateKey = stringField(fields, "private_key");
  if (privateKey) registerCredentialValue(privateKey);
  registerCredentialValue(text);
  if ("project_info" in fields || "client" in fields) {
    throw new Error(
      `${name} is google-services.json, not a service account key.\n${GOOGLE_PLAY_GUIDE_URL}`,
    );
  }
  if (fields["type"] !== "service_account") {
    throw new Error(
      `${name} is not a service account key: its type isn't service_account.`,
    );
  }
  const email = stringField(fields, "client_email");
  if (!privateKey || !email) {
    throw new Error(`${name} has no private_key or client_email.`);
  }
  const keyId = stringField(fields, "private_key_id");
  return { json: text, email, ...(keyId ? { keyId } : {}) };
};

/** One line of a Google Play check: passed, failed, or not checked. */
export interface PlayCheck {
  readonly ok: boolean | undefined;
  readonly label: string;
  readonly detail?: string;
  /** The lines under it, such as the command that fixes it. */
  readonly lines?: readonly string[];
}

/**
 * What a service account's access to `packageName` says, as a check line:
 * the invite to send, or the app's first upload, when it fails. Doctor's
 * Google Play rows and the build's check share it.
 */
export const describePlayAccess = (
  access: PlayAccess,
  label = "Play access",
): PlayCheck => {
  switch (access.status) {
    case "ready":
      return { ok: true, label };
    case "denied":
      return {
        ok: false,
        label,
        detail: "invite the service account",
        lines: [
          access.email,
          `App permission: ${PLAY_PERMISSION}`,
          ui.path(playConsoleInviteUrl(access.email)),
        ],
      };
    case "not-found":
      return {
        ok: false,
        label: label === "Play access" ? "App in Play" : label,
        detail: "upload the first .aab in Play Console",
      };
    case "refused":
      return {
        ok: false,
        label: label === "Play access" ? "Service account key" : label,
        detail: "Google refuses it",
        lines: access.reason.split("\n"),
      };
  }
};

const LABEL_WIDTH = 19;

/** A command under a check line, which `formatPlayChecks` indents two columns. */
const COMMAND_WIDTH = 72;

const MARKS = {
  true: ui.success("✓"),
  false: ui.danger("✗"),
  undefined: ui.muted("·"),
} as const;

/** The widest check line, Clack's three-column gutter left out. */
const CHECK_WIDTH = 77;

/**
 * Check lines, aligned, each with the lines under it indented. A detail
 * that doesn't fit beside a long label, such as an application ID, goes
 * on the line under it.
 */
export const formatPlayChecks = (checks: readonly PlayCheck[]): string[] =>
  checks.flatMap(({ ok, label, detail, lines = [] }) => {
    const mark = MARKS[String(ok) as keyof typeof MARKS];
    const beside = detail && `${label.padEnd(LABEL_WIDTH)}  ${detail}`;
    const fits = beside !== undefined && 2 + beside.length <= CHECK_WIDTH;
    return [
      `${mark} ${beside && fits ? beside : label}`,
      ...(detail && !fits ? [detail] : []),
      ...lines,
    ].map((line, index) => (index === 0 ? line : `  ${line}`));
  });

export interface GooglePlayReadiness {
  readonly packageName: string;
  readonly ready: boolean;
  readonly checks: readonly PlayCheck[];
  /** The service account, resolved, when it is. */
  readonly serviceAccount?: Credentials["play-service-account"];
}

const errorLines = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n");

/**
 * Resolves `request` with `credentials`: the value, or the check line
 * that says what is missing, with the one command that stores it.
 */
const resolveCheck = async <
  TKind extends "play-service-account" | "android-keystore",
>(
  credentials: CredentialResolver,
  request: CredentialRequest<TKind>,
  label: string,
): Promise<{ value?: Credentials[TKind]; check: PlayCheck }> => {
  try {
    return {
      value: await credentials.resolve(request),
      check: { ok: true, label },
    };
  } catch (error) {
    if (
      error instanceof CredentialUnavailableError &&
      error.message.startsWith("No ")
    ) {
      return {
        check: {
          ok: false,
          label,
          // Indented under the check: two columns fewer than a command.
          lines: ui
            .commandLines(
              credentialPutCommand(request.kind, request.name ?? request.kind),
              COMMAND_WIDTH,
            )
            .split("\n"),
        },
      };
    }
    return { check: { ok: false, label, lines: errorLines(error) } };
  }
};

/**
 * Everything a release to Google Play needs, checked before a build so
 * nothing waits through one only to be refused, each line passed or not:
 *
 * 1. the service account key, `serviceAccount`, resolves;
 * 2. the upload keystore the scheme signs with, `keystore`, resolves;
 *    without one, Gradle's own signing config signs, which is not checked;
 * 3. with the key, it opens an edit of `packageName` and deletes it: a
 *    refusal names the invite to send, a missing app its first upload.
 *
 * Both resolve through `credentials`, which keeps them for the build.
 */
export const checkGooglePlay = async ({
  credentials,
  packageName,
  serviceAccount,
  keystore,
  fetch,
}: {
  credentials: CredentialResolver;
  packageName: string;
  serviceAccount: CredentialRequest<"play-service-account">;
  keystore?: CredentialRequest<"android-keystore">;
  fetch?: typeof globalThis.fetch;
}): Promise<GooglePlayReadiness> => {
  const [key, upload] = await Promise.all([
    resolveCheck(credentials, serviceAccount, "Service account key"),
    keystore
      ? resolveCheck(credentials, keystore, "Upload keystore")
      : {
          check: {
            ok: undefined,
            label: "Upload keystore",
            detail: "Gradle's signing config",
          },
        },
  ]);
  let keyCheck = key.check;
  let access: PlayCheck | undefined;
  if (!key.value) {
    access = {
      ok: undefined,
      label: "Play access",
      detail: "checked once the key is stored",
    };
  } else {
    let result: PlayAccess | undefined;
    try {
      result = await checkPlayAccess({
        serviceAccount: key.value,
        packageName,
        ...(fetch ? { fetch } : {}),
      });
    } catch (error) {
      access = {
        ok: false,
        label: "Play access",
        detail: "can't check",
        lines: errorLines(error),
      };
    }
    if (result?.status === "refused") {
      // The key itself is what fails: its line says so.
      keyCheck = describePlayAccess(result);
      access = {
        ok: undefined,
        label: "Play access",
        detail: "checked once the key works",
      };
    } else if (result) {
      access = describePlayAccess(result);
    }
  }
  const checks = [keyCheck, upload.check, access!];
  return {
    packageName,
    ready: checks.every(({ ok }) => ok !== false),
    checks,
    ...(key.value ? { serviceAccount: key.value } : {}),
  };
};

/** The block a build prints when Google Play isn't ready, then exits. */
export const formatGooglePlayReadiness = ({
  packageName,
  checks,
}: GooglePlayReadiness): string =>
  [
    `Google Play isn't ready for ${packageName}:`,
    ...formatPlayChecks(checks),
    `Guide: ${ui.path(GOOGLE_PLAY_GUIDE_URL)}`,
  ].join("\n");
