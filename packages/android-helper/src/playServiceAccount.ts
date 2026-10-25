import { createGoogleKeyIssuer } from "./google/googleKeyIssuer";
import type { GoogleOAuthClient } from "./google/types";

export {
  GOOGLE_OAUTH_CLIENT_ENV_NAMES,
  type GoogleOAuthClient,
  PLAY_CONSOLE_URL,
  PLAY_SERVICE_ACCOUNT_ID,
  PlayServiceAccountError,
  type PlayServiceAccountErrorCode,
} from "./google/types";

/**
 * Hot Updater's Google OAuth client, a "Desktop app" client the sign-in
 * opens Google's consent screen for. Empty in a build that has none, where
 * `HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID` and `_SECRET` name one.
 */
export const HOT_UPDATER_GOOGLE_OAUTH_CLIENT: GoogleOAuthClient = {
  clientId: "",
  clientSecret: "",
};

/** A Google Cloud project the signed-in account can use. */
export interface GoogleCloudProject {
  readonly projectId: string;
  readonly displayName?: string;
}

export interface IssuePlayServiceAccountRequest {
  /** The app's package name in Google Play, which the service account may release. */
  readonly packageName: string;
  /** The OAuth client to sign in with; Hot Updater's unless set. */
  readonly oauthClient?: GoogleOAuthClient;
  /** Sees the sign-in URL, to print it and open it in a browser. */
  readonly onSignInUrl: (url: string) => Promise<void> | void;
  /** Asks for the Play Console developer account ID, after the sign-in. */
  readonly askDeveloperId: () => Promise<string>;
  /**
   * Sees the account's projects when there are any, and returns the one to
   * create the service account in, or undefined to create a project.
   */
  readonly chooseProject: (
    projects: readonly GoogleCloudProject[],
  ) => Promise<string | undefined>;
  /** Reports each step, such as "Creating the service account". */
  readonly onStep?: (message: string) => void;
}

/**
 * A Play service account's JSON key, just created, with the access token
 * of the sign-in it was created in. `revoke` deletes the key while the
 * sign-in lasts, and `dispose` ends the sign-in.
 */
export interface IssuedPlayServiceAccount {
  /** The JSON key file, as Google Cloud downloads it. */
  readonly json: string;
  /** The service account's email, the Play Console user it releases as. */
  readonly email: string;
  readonly projectId: string;
  readonly developerId: string;
  /** The key's ID, as Google Cloud lists it under the service account's keys. */
  readonly keyId: string;
  /** Deletes the key with the same sign-in; whether Google Cloud did. */
  revoke(): Promise<boolean>;
  /** Ends the sign-in: Google revokes its access token. */
  dispose(): Promise<void>;
}

/**
 * Signs in with Google and issues a service account key that releases the
 * app to Google Play: the developer signs in on Google's own consent
 * screen, in a browser, and the caller never sees the password. Nothing of
 * the sign-in outlives `dispose`.
 */
export type IssuePlayServiceAccount = (
  request: IssuePlayServiceAccountRequest,
) => Promise<IssuedPlayServiceAccount>;

/**
 * Hot Updater's issuer, the one place that picks how it is done: Google's
 * OAuth for installed apps, then the Cloud Resource Manager, Service Usage,
 * IAM, and Play Developer APIs. Another implementation of
 * `IssuePlayServiceAccount` replaces it here without touching its callers.
 */
export const issuePlayServiceAccount: IssuePlayServiceAccount = (request) =>
  createGoogleKeyIssuer()({
    ...request,
    oauthClient: request.oauthClient ?? HOT_UPDATER_GOOGLE_OAUTH_CLIENT,
  });
