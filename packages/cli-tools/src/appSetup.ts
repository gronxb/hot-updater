import { p } from "./prompts";

/** The credential init gives an app, through the server's clientAuth plugin. */
export interface AppClientCredential {
  /** Its name in output, such as "API key". */
  readonly label: string;
  /** The request header that carries it. */
  readonly header: string;
  readonly value: string;
}

/**
 * The App.tsx code init prints: `HotUpdater.init` with the server's URL
 * and, when the server takes a client credential, the header that carries it.
 */
export const renderAppSetup = ({
  baseURL,
  credential,
}: {
  readonly baseURL: string;
  readonly credential?: AppClientCredential;
}): string =>
  [
    "// Add this to your App.tsx",
    'import { HotUpdater } from "@hot-updater/react-native";',
    "",
    "function App() {",
    "  return null; // Replace with your app root.",
    "}",
    "",
    "HotUpdater.init({",
    `  baseURL: ${JSON.stringify(baseURL)},`,
    ...(credential === undefined
      ? []
      : [
          "  requestHeaders: {",
          `    ${JSON.stringify(credential.header)}: ${JSON.stringify(credential.value)},`,
          "  },",
        ]),
    "});",
    "",
    '// Call HotUpdater.checkForUpdate({ updateStrategy: "appVersion" })',
    "// when your app is ready to check.",
    "export default App;",
  ].join("\n");

/** Prints the App.tsx code, when the URL is known, and the app's credential. */
export const printAppSetup = ({
  baseURL,
  credential,
}: {
  readonly baseURL?: string;
  readonly credential?: AppClientCredential;
}): void => {
  if (baseURL !== undefined) {
    p.note(
      renderAppSetup({
        baseURL,
        ...(credential === undefined ? {} : { credential }),
      }),
    );
  }
  if (credential !== undefined) {
    p.note(credential.value, credential.label);
    p.log.message(
      `Store this ${credential.label} separately in a secure place.`,
    );
  }
};
