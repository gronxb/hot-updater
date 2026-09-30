/** The example's own plugin, which its managed servers run beside the provider's. */
export const SAMPLE_PLUGIN_ID = "sample";

export type SamplePluginEvidence =
  | { readonly skipped: string }
  | {
      readonly plugin: typeof SAMPLE_PLUGIN_ID;
      readonly id: string;
      readonly attempts: number;
    };

/**
 * Proves the deployed server runs the example's own plugin: a note written
 * through the plugin's API, on the server's database, is what the server's
 * client endpoint answers. That covers the bundle, the plugin's table and
 * settings row, the role's access to them, and the route to the endpoint.
 * A server whose definition runs no sample plugin, such as a self-hosted
 * one, is skipped.
 */
export async function checkSamplePlugin({
  plugins,
  write,
  get,
  id,
  attempts = 30,
  wait = async () => undefined,
}: {
  /** The server definition's plugins; none for a self-hosted server. */
  readonly plugins: readonly unknown[] | undefined;
  /** Writes a note through the sample plugin alone, which it is given. */
  readonly write: (
    samplePlugins: readonly unknown[],
    id: string,
    text: string,
  ) => Promise<void>;
  /** A GET of a path on the deployed server, with the app's credential. */
  readonly get: (path: string) => Promise<Response>;
  readonly id: string;
  readonly attempts?: number;
  readonly wait?: () => Promise<void>;
}): Promise<SamplePluginEvidence> {
  const samplePlugins = (plugins ?? []).filter(
    (plugin) => (plugin as { readonly id?: unknown }).id === SAMPLE_PLUGIN_ID,
  );
  if (samplePlugins.length === 0) {
    return { skipped: "The server definition runs no sample plugin." };
  }
  const text = `Written by the E2E run as note ${id}`;
  await write(samplePlugins, id, text);
  const path = `/sample/notes/${encodeURIComponent(id)}`;
  let last = "no response";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await get(path);
    if (response.ok) {
      const body = (await response.json()) as { readonly text?: unknown };
      if (body.text !== text) {
        throw new Error(
          `GET ${path} on the deployed server answered ${JSON.stringify(body)}, not the note the sample plugin wrote.`,
        );
      }
      return { plugin: SAMPLE_PLUGIN_ID, id, attempts: attempt };
    }
    last = `${response.status} ${await response.text()}`;
    if (attempt < attempts) await wait();
  }
  throw new Error(
    `The deployed server never served the sample plugin's note: GET ${path} last answered ${last}. Redeploy the managed server with the example's server definition.`,
  );
}
