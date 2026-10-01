import {
  getBundleSigningPublicKey,
  getCwd,
  loadConfig,
} from "@hot-updater/cli-tools";

import { isExpoCNG } from "../../utils/expoDetection";
import { syncFingerprintFiles } from "../../utils/fingerprint";
import { isProjectFileTracked } from "../../utils/git";
import { writePublicKeyToNativeFiles } from "../keys";
import type { DoctorContext } from "./context";
import type { DoctorFix, DoctorIssueCode } from "./issues";
import {
  deleteUnreferencedArtifacts,
  rebuildReleaseCatalogs,
} from "./serverData";

type Code = DoctorIssueCode;

/** What a repair reads of the issues it repairs. */
interface RepairedIssue {
  readonly code: Code;
  readonly scopeKey?: string;
  readonly artifactIds?: readonly string[];
}

/** What a repair wrote, and whether native files were among it; or why it wrote nothing. */
type RepairResult =
  | { readonly wrote: string[]; readonly native: boolean }
  | { readonly skip: string };

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

const serverCore = async (context: DoctorContext) => {
  const server = await context.server();
  if (server === null)
    throw new Error("hot-updater.config.ts names no server.");
  return server.core;
};

/** The repairs doctor can run, each for the issues it repairs. */
const REPAIRS: readonly {
  readonly repair: DoctorFix["repair"];
  readonly codes: readonly Code[];
  /** It writes native files, which an Expo prebuild would overwrite. */
  readonly writesNativeFiles: boolean;
  /** Runs the repair for its issues. */
  readonly run?: (
    issues: readonly RepairedIssue[],
    context: DoctorContext,
  ) => Promise<RepairResult>;
  /** Why --fix leaves these issues to the user: they have more than one remedy. */
  readonly reportOnly?: string;
  /** What to know once it applied, for these issues. */
  readonly note?: (codes: readonly Code[]) => string | undefined;
}[] = [
  {
    // What `fingerprint create` writes, where it differs.
    repair: "fingerprint",
    codes: [
      "MISSING_FINGERPRINT_JSON",
      "MISSING_FINGERPRINT_HASH",
      "FINGERPRINT_HASH_MISMATCH",
      "FINGERPRINT_JSON_STALE",
    ],
    writesNativeFiles: true,
    run: async (_issues, context) => {
      const { fingerprintJson, iosPaths, androidPaths } =
        await syncFingerprintFiles(await context.fingerprints());
      return {
        wrote: [
          ...(fingerprintJson ? ["fingerprint.json"] : []),
          ...iosPaths,
          ...androidPaths,
        ],
        native: iosPaths.length + androidPaths.length > 0,
      };
    },
  },
  {
    // What `keys export-public --yes` writes.
    repair: "public-key",
    codes: ["MISSING_PUBLIC_KEY", "PUBLIC_KEY_MISMATCH"],
    writesNativeFiles: true,
    run: async () => {
      const config = await loadConfig(null);
      const publicKey = config.signing
        ? await getBundleSigningPublicKey(config.signing, { cwd: getCwd() })
        : null;
      if (!publicKey) throw new Error("Bundle signing is not configured.");
      const results = await writePublicKeyToNativeFiles(publicKey, config);
      if (results.length === 0) {
        return {
          skip: "The project has no native files to write the key into; follow the issue's resolution.",
        };
      }
      const wrote = written(results);
      return { wrote, native: wrote.length > 0 };
    },
    note: (codes) =>
      codes.includes("PUBLIC_KEY_MISMATCH")
        ? "The native files now hold the configured public key. Apps already installed keep the previous key and reject bundles signed with the configured one."
        : undefined,
  },
  {
    // Two remedies: remove the key, or enable signing.
    repair: "orphan-public-key",
    codes: ["ORPHAN_PUBLIC_KEY"],
    writesNativeFiles: true,
    reportOnly:
      "doctor --fix never removes a public key. The issue has two remedies, and removing the key turns off signature verification in the app if signing is set up where this machine cannot see it, such as an environment variable only CI sets. Run `npx hot-updater keys remove` yourself, or enable signing in hot-updater.config.ts.",
  },
  {
    // Each stale scope's catalog, rebuilt from its releases.
    repair: "release-catalogs",
    codes: ["RELEASE_CATALOG_STALE"],
    writesNativeFiles: false,
    run: async (issues, context) => ({
      wrote: await rebuildReleaseCatalogs(
        await serverCore(context),
        issues.flatMap(({ scopeKey }) =>
          scopeKey === undefined ? [] : [scopeKey],
        ),
      ),
      native: false,
    }),
  },
  {
    // The artifact records no release uses.
    repair: "unreferenced-artifacts",
    codes: ["UNREFERENCED_ARTIFACTS"],
    writesNativeFiles: false,
    run: async (issues, context) => ({
      wrote: await deleteUnreferencedArtifacts(
        await serverCore(context),
        issues.flatMap(({ artifactIds }) => artifactIds ?? []),
      ),
      native: false,
    }),
  },
];

/**
 * Whether this is an Expo project whose native folders prebuild generates:
 * a write to them would be overwritten by the next `expo prebuild`.
 */
const prebuildOwnsNativeFiles = (cwd: string): boolean =>
  isExpoCNG(cwd) &&
  !["ios", "android"].some((filePath) =>
    isProjectFileTracked({ cwd, filePath }),
  );

/**
 * Runs each repair once for the issues it repairs, in order, and reports
 * what each wrote. A repair of native files is skipped on an Expo project
 * whose native folders prebuild generates, and an issue with more than one
 * remedy is left to the user.
 */
export const applyDoctorFixes = async (
  issues: readonly RepairedIssue[],
  context: DoctorContext,
): Promise<DoctorFix[]> => {
  const fixes: DoctorFix[] = [];
  for (const repair of REPAIRS) {
    const matched = issues.filter(({ code }) => repair.codes.includes(code));
    if (matched.length === 0) continue;
    const codes = repair.codes.filter((code) =>
      matched.some((issue) => issue.code === code),
    );
    const skipped = (note: string): DoctorFix => ({
      repair: repair.repair,
      codes,
      status: "skipped",
      wrote: [],
      native: false,
      note,
    });
    if (repair.reportOnly !== undefined || repair.run === undefined) {
      fixes.push(
        skipped(repair.reportOnly ?? "doctor --fix cannot repair it."),
      );
      continue;
    }
    if (repair.writesNativeFiles && prebuildOwnsNativeFiles(context.cwd)) {
      fixes.push(
        skipped(
          "This Expo project generates its native files with `expo prebuild`, which would overwrite the repair.",
        ),
      );
      continue;
    }
    try {
      const result = await repair.run(matched, context);
      if ("skip" in result) {
        fixes.push(skipped(result.skip));
        continue;
      }
      const note = repair.note?.(codes);
      fixes.push({
        repair: repair.repair,
        codes,
        status: "applied",
        wrote: result.wrote,
        native: result.native,
        ...(note === undefined ? {} : { note }),
      });
    } catch (error) {
      fixes.push({
        repair: repair.repair,
        codes,
        status: "failed",
        wrote: [],
        native: false,
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return fixes;
};
