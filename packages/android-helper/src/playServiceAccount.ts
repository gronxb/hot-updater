import { createGoogleKeyIssuer } from "./google/googleKeyIssuer";

export {
  PLAY_SERVICE_ACCOUNT_ID,
  PlayServiceAccountError,
  type PlayServiceAccountErrorCode,
} from "./google/types";

/** A Google Cloud project the signed-in account can use. */
export interface GoogleCloudProject {
  readonly projectId: string;
  readonly displayName?: string;
}

export interface IssuePlayServiceAccountRequest {
  /** The app's package name in Google Play, which the service account may release. */
  readonly packageName: string;
  /**
   * Sees Play Console's page that invites the service account `email`, to
   * print it and open it in a browser; the issuer then waits for the invite.
   */
  readonly onInvite: (url: string, email: string) => Promise<void> | void;
  /**
   * Sees the account's projects when Google refuses to create one for it,
   * and returns the one to create the service account in, or undefined to
   * stop with Google's refusal.
   */
  readonly chooseProject: (
    projects: readonly GoogleCloudProject[],
  ) => Promise<string | undefined>;
  /** Reports each step, such as "Creating the service account". */
  readonly onStep?: (message: string) => void;
}

/**
 * A Play service account's JSON key, just created, which already reaches
 * the app in Google Play. `revoke` deletes the key with gcloud's sign-in.
 */
export interface IssuedPlayServiceAccount {
  /** The JSON key file, as Google Cloud downloads it. */
  readonly json: string;
  /** The service account's email, the Play Console user it releases as. */
  readonly email: string;
  readonly projectId: string;
  /** The key's ID, as Google Cloud lists it under the service account's keys. */
  readonly keyId: string;
  /** Deletes the key with gcloud's sign-in; whether Google Cloud did. */
  revoke(): Promise<boolean>;
  /** Releases what the issue held; gcloud keeps its own sign-in. */
  dispose(): Promise<void>;
}

/**
 * Issues a service account key that releases the app to Google Play, with
 * the gcloud CLI's Google sign-in: the caller never sees the password, and
 * the developer invites the service account in Play Console once.
 */
export type IssuePlayServiceAccount = (
  request: IssuePlayServiceAccountRequest,
) => Promise<IssuedPlayServiceAccount>;

/**
 * Hot Updater's issuer, the one place that picks how it is done: gcloud's
 * sign-in, then the Cloud Resource Manager, Service Usage, IAM, and Play
 * Developer APIs. Another implementation of `IssuePlayServiceAccount`
 * replaces it here without touching its callers.
 */
export const issuePlayServiceAccount: IssuePlayServiceAccount = (request) =>
  createGoogleKeyIssuer()(request);
