import {
  getBundleSigningPublicKey,
  getCwd,
  loadConfig,
} from "@hot-updater/cli-tools";

import { isExpoCNG } from "../../utils/expoDetection";
import { createAndInjectFingerprintFiles } from "../../utils/fingerprint";
import { isProjectFileTracked } from "../../utils/git";
import {
  removePublicKeyFromNativeFiles,
  writePublicKeyToNativeFiles,
} from "../keys";
import type { DoctorFix, DoctorIssueCode } from "./issues";
import { rebuildReleaseCatalogs } from "./releaseCatalogs";

type Code = DoctorIssueCode;

/** What a repair reads of the issues it repairs. */
interface RepairedIssue {
  readonly code: Code;
  readonly scopeKey?: string;
}

/** The files a native-file repair wrote, or an error naming each platform it failed on. */
const written = (
  results: readonly {
    readonly platform: string;
    readonly paths: readonly string[];
    readonly success: boolean;
    readonly error?: string;
  }[],
): string[] => {
  const failed = results.filter(({ success }) => !success);
  if (failed.length > 0) {
    throw new Error(
      failed.map(({ platform, error }) => `${platform}: ${error}`).join("; "),
    );
  }
  return results.flatMap(({ paths }) => paths);
};

/** The repairs doctor runs itself, each for the issues it repairs. */
const REPAIRS: readonly {
  readonly repair: DoctorFix["repair"];
  readonly codes: readonly Code[];
  readonly native: boolean;
  /** Runs the repair for its issues and returns everything it wrote. */
  readonly run: (issues: readonly RepairedIssue[]) => Promise<string[]>;
  /** What to know once it applied, for these issues. */
  readonly note?: (codes: readonly Code[]) => string | undefined;
}[] = [
  {
    // What `fingerprint create` writes.
    repair: "fingerprint",
    codes: [
      "MISSING_FINGERPRINT_JSON",
      "MISSING_FINGERPRINT_HASH",
      "FINGERPRINT_HASH_MISMATCH",
      "FINGERPRINT_JSON_STALE",
    ],
    native: true,
    run: async () => {
      const { androidPaths, iosPaths } =
        await createAndInjectFingerprintFiles();
      return ["fingerprint.json", ...iosPaths, ...androidPaths];
    },
  },
  {
    // What `keys export-public --yes` writes.
    repair: "public-key",
    codes: ["MISSING_PUBLIC_KEY", "PUBLIC_KEY_MISMATCH"],
    native: true,
    run: async () => {
      const config = await loadConfig(null);
      const publicKey = config.signing
        ? await getBundleSigningPublicKey(config.signing, { cwd: getCwd() })
        : null;
      if (!publicKey) throw new Error("Bundle signing is not configured.");
      return written(await writePublicKeyToNativeFiles(publicKey, config));
    },
    note: (codes) =>
      codes.includes("PUBLIC_KEY_MISMATCH")
        ? "The native files now hold the configured public key. Apps already installed keep the previous key and reject bundles signed with the configured one."
        : undefined,
  },
  {
    // What `keys remove --yes` removes.
    repair: "orphan-public-key",
    codes: ["ORPHAN_PUBLIC_KEY"],
    native: true,
    run: async () =>
      written(await removePublicKeyFromNativeFiles(await loadConfig(null))),
  },
  {
    // Each stale scope's catalog, rebuilt from its releases.
    repair: "release-catalogs",
    codes: ["RELEASE_CATALOG_STALE"],
    native: false,
    run: async (issues) =>
      rebuildReleaseCatalogs(
        await loadConfig(null),
        issues.flatMap(({ scopeKey }) =>
          scopeKey === undefined ? [] : [scopeKey],
        ),
      ),
  },
];

/**
 * Whether this is an Expo project whose native folders prebuild generates:
 * a write to them would be overwritten by the next `expo prebuild`.
 */
const prebuildOwnsNativeFiles = (cwd: string): boolean =>
  isExpoCNG() &&
  !["ios", "android"].some((filePath) =>
    isProjectFileTracked({ cwd, filePath }),
  );

/**
 * Runs each repair once for the issues it repairs, in order, and reports
 * what each wrote. A repair of native files is skipped on an Expo project
 * whose native folders prebuild generates.
 */
export const applyDoctorFixes = async (
  issues: readonly RepairedIssue[],
  { cwd }: { readonly cwd: string },
): Promise<DoctorFix[]> => {
  const fixes: DoctorFix[] = [];
  for (const { repair, codes, native, run, note } of REPAIRS) {
    const matched = issues.filter(({ code }) => codes.includes(code));
    const repaired = codes.filter((code) =>
      matched.some((issue) => issue.code === code),
    );
    if (repaired.length === 0) continue;
    const fix = { repair, codes: repaired, native };
    if (native && prebuildOwnsNativeFiles(cwd)) {
      fixes.push({
        ...fix,
        status: "skipped",
        wrote: [],
        note: "This Expo project generates its native files with `expo prebuild`, which would overwrite the repair.",
      });
      continue;
    }
    try {
      const wrote = await run(matched);
      const applied = note?.(repaired);
      fixes.push({
        ...fix,
        status: "applied",
        wrote,
        ...(applied === undefined ? {} : { note: applied }),
      });
    } catch (error) {
      fixes.push({
        ...fix,
        status: "failed",
        wrote: [],
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return fixes;
};
