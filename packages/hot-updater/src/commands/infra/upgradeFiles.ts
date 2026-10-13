import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { isLess, normalize } from "verkit";

import type { InfrastructureUpdate } from "../infrastructureUpdates";
import type { InitProvider } from "../initProviders";

/**
 * Each provider's section heading. A provider added after some release files
 * existed names the last file before it: those files stay as released, and
 * every later file needs the provider's section.
 */
const PROVIDER_SECTIONS = {
  cloudflare: { heading: "Cloudflare" },
  supabase: { heading: "Supabase" },
  aws: { heading: "AWS" },
  firebase: { heading: "Firebase" },
  vercel: { heading: "Vercel", addedAfter: "1.0.0" },
} as const satisfies Record<
  InitProvider,
  { readonly heading: string; readonly addedAfter?: string }
>;

type ProviderSection = (typeof PROVIDER_SECTIONS)[InitProvider];

const addedAfterOf = (section: ProviderSection) =>
  "addedAfter" in section ? section.addedAfter : undefined;

/** The provider sections a release file needs: every provider it predates none of. */
const providerHeadingsFor = (version: string) =>
  Object.values(PROVIDER_SECTIONS).flatMap((section) => {
    const addedAfter = addedAfterOf(section);
    return addedAfter === undefined || isLess(addedAfter, version)
      ? [section.heading]
      : [];
  });

export interface InfrastructureUpgradeFile extends InfrastructureUpdate {
  file: string;
  content: string;
}

export async function readInfrastructureUpgradeFiles(
  directory: string,
  requirements: readonly InfrastructureUpdate[],
): Promise<InfrastructureUpgradeFile[]> {
  if (requirements.length === 0)
    throw new Error("Infrastructure upgrade requirements must not be empty.");
  const filenames = (await readdir(directory))
    .filter((file) => file.endsWith(".md"))
    .sort();
  const expected = requirements.map(({ version }) => `${version}.md`).sort();
  if (JSON.stringify(filenames) !== JSON.stringify(expected)) {
    throw new Error(
      "Infrastructure requirements and versioned Markdown files must match exactly.",
    );
  }
  const upgrades: InfrastructureUpgradeFile[] = [];
  for (const requirement of requirements) {
    const { version, note } = requirement;
    const previous = upgrades.at(-1);
    if (
      normalize(version) !== version ||
      (previous && !isLess(previous.version, version)) ||
      !note.trim()
    ) {
      throw new Error(
        "Infrastructure requirements need unique, ascending versions and a note.",
      );
    }
    const file = `${version}.md`;
    const content = await readFile(path.join(directory, file), "utf8");
    if (
      content.split(/\r?\n/, 1)[0] !== `# ${version}` ||
      /\b(TODO|TBD|FIXME)\b/.test(content)
    ) {
      throw new Error(
        `${file} needs its version heading and completed instructions.`,
      );
    }
    const parts = content.split(/^## (.+)\r?$/m);
    const sections = new Map<string, string>();
    for (let index = 1; index < parts.length; index += 2) {
      const heading = parts[index]!;
      if (sections.has(heading))
        throw new Error(`${file} repeats section ${heading}.`);
      sections.set(heading, parts[index + 1]?.trim() ?? "");
    }
    for (const heading of [
      "Compatibility",
      "Steps",
      ...providerHeadingsFor(version),
      "Verification",
    ]) {
      if (!sections.get(heading))
        throw new Error(`${file} is missing instructions for ${heading}.`);
    }
    upgrades.push({ ...requirement, file, content });
  }
  return upgrades;
}

export const renderInfrastructureUpgradeIndex = (
  upgrades: readonly InfrastructureUpgradeFile[],
) =>
  [
    "# Infrastructure upgrades",
    "",
    "Inspect the live server version, infrastructure generation and migration history, and compare them with the target manifest. Unknown state requires investigation before choosing an upgrade path.",
    "",
    "Each file records one required infrastructure version. Read the applicable baseline for the installed generation as context, then every subsequent file through the target requirement in ascending order. If the deployed generation predates the first file, start with that file. Read all relevant files before applying any changes; do not skip intermediate releases or read only the newest file.",
    "",
    ...Object.values(PROVIDER_SECTIONS).flatMap((section) => {
      const addedAfter = addedAfterOf(section);
      return addedAfter === undefined
        ? []
        : [
            `${section.heading} was added after ${addedAfter}: files through ${addedAfter} have no ${section.heading} section. A ${section.heading} deployment applies the ${section.heading} sections of the files after ${addedAfter}; when none is listed, it needs no infrastructure change, and reconciling it with this scaffold follows the upgrade section of its SETUP.md.`,
            "",
          ];
    }),
    "Use the common sections and your provider's section to plan the full transition. Previously completed steps provide context and must not be replayed blindly. Inspect actual migration/resource state, preserve customizations and secrets, and record which version files and steps have been applied and verified. Apply pending changes in order using the target scaffold; investigate conflicting requirements before proceeding.",
    "",
    ...upgrades.map(
      ({ version, note, file }) => `- [${version}](./${file}) — ${note}`,
    ),
    "",
  ].join("\n");
