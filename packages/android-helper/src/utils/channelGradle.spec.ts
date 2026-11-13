import { describe, expect, it } from "vitest";

import { channelInitScript } from "./channelGradle";

describe("channelInitScript", () => {
  const script = channelInitScript({
    appModuleName: "app",
    variant: "stagingRelease",
    channel: "pr-7",
  });

  it("rewrites the merged manifest of the app module's variant, whatever merged into it", () => {
    expect(script).toContain("def appModule = ':app'");
    expect(script).toContain("def variantName = 'stagingrelease'");
    expect(script).toContain("def channel = 'pr-7'");
    expect(script).toContain(
      "'com.android.build.api.artifact.SingleArtifact$MERGED_MANIFEST'",
    );
    expect(script).toContain(".toTransform(mergedManifest)");
    // The SDK's meta-data, replaced or added once.
    expect(script).toContain(
      '<meta-data android:name=\\"com.hotupdater.CHANNEL\\" android:value=\\"${value}\\" />',
    );
  });

  it("holds a channel as one Groovy string, and escapes it for XML in the task", () => {
    const quoted = channelInitScript({
      appModuleName: "app",
      variant: "Release",
      channel: "it's\\x",
    });
    expect(quoted).toContain("def channel = 'it\\'s\\\\x'");
    expect(script).toContain(".replace('&', '&amp;').replace('\"', '&quot;')");
  });
});
