import fs from "fs";
import os from "os";
import path from "path";

/** Text as a single-quoted Groovy string. */
const groovyString = (text: string) =>
  `'${text
    .replace(/\\/gu, "\\\\")
    .replace(/'/gu, "\\'")
    .replace(/\n/gu, "\\n")}'`;

/**
 * The init script that makes one build embed `channel`, so no project file
 * changes: on the app module, a task rewrites the variant's merged manifest
 * (AGP's `MERGED_MANIFEST` transform), replacing or adding the
 * `com.hotupdater.CHANNEL` meta-data the SDK reads. It runs after every
 * manifest merged, the app's, a flavor's, an Expo config plugin's and a
 * sandbox build's, so the channel is this one whatever they set.
 */
export const channelInitScript = ({
  appModuleName,
  variant,
  channel,
}: {
  appModuleName: string;
  variant: string;
  channel: string;
}) => `// Written by hot-updater for one build: the channel it embeds.
def appModule = ${groovyString(`:${appModuleName}`)}
def variantName = ${groovyString(variant.toLowerCase())}
def channel = ${groovyString(channel)}
allprojects { project ->
  if (project.path != appModule) return
  project.plugins.withId('com.android.application') {
    def components = project.extensions.getByName('androidComponents')
    def mergedManifest = components.getClass().classLoader
      .loadClass('com.android.build.api.artifact.SingleArtifact$MERGED_MANIFEST')
      .getField('INSTANCE').get(null)
    components.onVariants(components.selector().all()) { v ->
      if (v.name.toLowerCase() != variantName) return
      def stamp = project.tasks.register("hotUpdaterChannel\${v.name.capitalize()}", HotUpdaterChannelManifest) {
        it.channel.set(channel)
      }
      v.artifacts.use(stamp)
        .wiredWithFiles({ it.inputManifest }, { it.outputManifest })
        .toTransform(mergedManifest)
    }
  }
}

abstract class HotUpdaterChannelManifest extends DefaultTask {
  @InputFile abstract RegularFileProperty getInputManifest()
  @OutputFile abstract RegularFileProperty getOutputManifest()
  @Input abstract Property<String> getChannel()

  @TaskAction void stamp() {
    def value = channel.get()
      .replace('&', '&amp;').replace('"', '&quot;')
      .replace('<', '&lt;').replace('>', '&gt;')
    def text = inputManifest.get().asFile.getText('UTF-8')
      .replaceAll(/(?s)<meta-data\\b(?:(?!\\/>|>).)*?android:name="com\\.hotupdater\\.CHANNEL"(?:(?!\\/>|>).)*?(?:\\/>|>.*?<\\/meta-data>)\\s*/, '')
    def entry = "<meta-data android:name=\\"com.hotupdater.CHANNEL\\" android:value=\\"\${value}\\" />"
    def closing = text.lastIndexOf('</application>')
    if (closing < 0) throw new GradleException('The merged manifest has no <application>.')
    outputManifest.get().asFile.setText(text.substring(0, closing) + entry + '\\n    ' + text.substring(closing), 'UTF-8')
  }
}
`;

/**
 * Runs `build` with the Gradle arguments that make it embed `channel`: none
 * without one. The init script is written outside the project, and removed
 * after.
 */
export const withChannelGradleArgs = async <T>(
  channel: string | undefined,
  scheme: { appModuleName: string; variant: string },
  build: (args: string[]) => Promise<T>,
): Promise<T> => {
  if (channel === undefined) return build([]);
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-channel-"),
  );
  try {
    const script = path.join(directory, "channel.init.gradle");
    await fs.promises.writeFile(
      script,
      channelInitScript({
        appModuleName: scheme.appModuleName,
        variant: scheme.variant,
        channel,
      }),
    );
    return await build(["--init-script", script]);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};
