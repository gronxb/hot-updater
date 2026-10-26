import { createAscCliKeyIssuer } from "./asc/ascCliKeyIssuer";

/** Where team API keys are listed and revoked in App Store Connect. */
export const ASC_INTEGRATIONS_URL =
  "https://appstoreconnect.apple.com/access/integrations/api";

/** A team API key's role, as App Store Connect names it. */
export type AscApiKeyRole = "ADMIN" | "APP_MANAGER" | "DEVELOPER";

/** The App Store Connect team an Apple Account signed in to. */
export interface AscTeam {
  readonly appleId?: string;
  /** The team ID to pass as `teamId` to issue the key in this team. */
  readonly teamId?: string;
  /** The Apple Developer team ID, as Xcode's DEVELOPMENT_TEAM names it. */
  readonly developerTeamId?: string;
}

export interface IssueAscApiKeyRequest {
  /** The key's name in App Store Connect. */
  readonly name: string;
  readonly role: AscApiKeyRole;
  /** The Apple Account to sign in with; the sign-in asks for it when unset. */
  readonly appleId?: string;
  /** The team to issue the key in; else the one the sign-in lands in. */
  readonly teamId?: string;
  /**
   * Sees the team the sign-in landed in, when `teamId` is unset, and
   * returns another team's ID to issue the key there instead.
   */
  readonly chooseTeam?: (team: AscTeam) => Promise<string | undefined>;
}

/**
 * An App Store Connect team API key, just issued, with its one-time private
 * key and the signed-in session it was issued in. `dispose` ends that
 * session and deletes everything the sign-in kept; `revoke` works until then.
 */
export interface IssuedAscApiKey {
  /** The `.p8` private key, a PEM. */
  readonly p8: string;
  readonly keyId: string;
  readonly issuerId: string;
  /** The key's name in App Store Connect. */
  readonly name: string;
  readonly team: AscTeam;
  /** Revokes the key with the same session; whether App Store Connect did. */
  revoke(): Promise<boolean>;
  dispose(): Promise<void>;
}

/**
 * Signs in to App Store Connect with an Apple Account and issues a team API
 * key. The developer types the password and the two-factor code into the
 * sign-in's prompts; the caller never sees them. Nothing of the sign-in
 * outlives `dispose`.
 */
export type IssueAscApiKey = (
  request: IssueAscApiKeyRequest,
) => Promise<IssuedAscApiKey>;

/**
 * Hot Updater's sign-in, the one place that picks how it is done: asc, the
 * open-source App Store Connect CLI. Another implementation of
 * `IssueAscApiKey` replaces it here without touching its callers.
 */
export const issueAscApiKey: IssueAscApiKey = (request) =>
  createAscCliKeyIssuer()(request);
