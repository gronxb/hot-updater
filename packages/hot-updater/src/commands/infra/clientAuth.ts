/**
 * The client-route policy a managed server's plugins set, as the packaged
 * scaffold records it: null when client routes are public.
 */
export type InfraClientAuth = {
  /** The plugin that provides clientAuth. */
  plugin: string;
  /** The request headers its decision reads, which CDN caches key on. */
  varyHeaders: string[];
  /** The credential an app sends. */
  credential: {
    label: string;
    header: string;
    /** The environment variable that holds it. */
    env: string;
  };
} | null;

/** Saves and registers the app's credential; beside the scaffold's app config. */
export const CLIENT_CREDENTIAL_SCRIPT = "provision-client-credential.mjs";

/** Where the script keeps the credential it generated, before registering it. */
export const CLIENT_CREDENTIAL_FILE = "client-credential.local";

/** The script's database config, named for its build like hot-updater.config. */
export const CLIENT_CREDENTIAL_CONFIG = "database.config";

const TOKENS = {
  "{{CREDENTIAL_LABEL}}": "label",
  "{{CREDENTIAL_HEADER}}": "header",
  "{{CREDENTIAL_ENV}}": "env",
} as const;

/**
 * Renders agent instructions for a server's client-route policy. Lines
 * between `<!-- if credential -->` and `<!-- else -->` or `<!-- end -->`
 * stay only when the server takes a credential, and the `else` part only
 * when its client routes are public; `{{CREDENTIAL_*}}` names the credential.
 */
export const renderAgentInstructions = (
  text: string,
  clientAuth: InfraClientAuth,
): string => {
  const lines: string[] = [];
  let branch: "if" | "else" | undefined;
  for (const [index, line] of text.split("\n").entries()) {
    const marker = line.trim();
    const at = `line ${index + 1}`;
    if (marker === "<!-- if credential -->") {
      if (branch !== undefined)
        throw new Error(`Nested credential block at ${at}.`);
      branch = "if";
    } else if (marker === "<!-- else -->") {
      if (branch !== "if") throw new Error(`Unexpected else at ${at}.`);
      branch = "else";
    } else if (marker === "<!-- end -->") {
      if (branch === undefined) throw new Error(`Unexpected end at ${at}.`);
      branch = undefined;
    } else if (
      branch === undefined ||
      (branch === "if") === (clientAuth !== null)
    ) {
      lines.push(line);
    }
  }
  if (branch !== undefined) throw new Error("Unclosed credential block.");
  let rendered = lines.join("\n");
  for (const [token, key] of Object.entries(TOKENS)) {
    if (!rendered.includes(token)) continue;
    if (clientAuth === null) {
      throw new Error(`${token} appears outside a credential block.`);
    }
    rendered = rendered.replaceAll(token, clientAuth.credential[key]);
  }
  return rendered;
};
