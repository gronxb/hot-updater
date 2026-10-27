import {
  blobSource,
  type ImportableNativeBuild,
  NativeArtifactError,
  type NativeArtifactInfo,
  type NativeArtifactProblem,
  readNativeArtifact,
} from "@hot-updater/protocol/native-artifact";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileUp,
  Loader2,
  Upload,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { queryKeys } from "@/lib/api";
import { checkNativeBuildImport } from "@/lib/api-rpc";
import { uploadNativeBuild } from "@/lib/native-build-import";
import { nativeBuildDetailPath, platformLabel } from "@/lib/native-builds";
import { cn } from "@/lib/utils";

/** What the check found of an importable artifact, kept through its upload. */
interface Checked {
  readonly info: NativeArtifactInfo;
  readonly updateStrategy: "fingerprint" | "appVersion";
  readonly build: ImportableNativeBuild;
}

/** Where an import is: each step the dialog shows. */
export type ImportState =
  | { readonly step: "pick" }
  | { readonly step: "reading"; readonly file: File }
  | {
      readonly step: "checked";
      readonly file: File;
      readonly info: NativeArtifactInfo | null;
      readonly updateStrategy: "fingerprint" | "appVersion" | null;
      readonly build: ImportableNativeBuild | null;
      readonly problems: readonly NativeArtifactProblem[];
    }
  | {
      readonly step: "uploading";
      readonly file: File;
      readonly checked: Checked;
      readonly sent: number;
    }
  | {
      readonly step: "registering";
      readonly file: File;
      readonly checked: Checked;
    }
  | {
      readonly step: "failed";
      readonly file: File;
      readonly checked: Checked;
      readonly problems: readonly NativeArtifactProblem[];
    };

const ACCEPT = ".ipa,.aab,.apk";

const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 * 1024
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const textOf = (value: NativeArtifactInfo["channel"]) =>
  value === null ? null : typeof value === "string" ? value : "unreadable";

/**
 * Reads a dropped artifact in the browser and asks the Console whether it
 * can be imported: the preview the user confirms. The upload reads it again
 * on the server, which decides.
 */
async function readAndCheck(file: File): Promise<ImportState> {
  let info: NativeArtifactInfo;
  try {
    info = await readNativeArtifact(blobSource(file), file.name);
  } catch (error) {
    return {
      step: "checked",
      file,
      info: null,
      updateStrategy: null,
      build: null,
      problems: [
        error instanceof NativeArtifactError
          ? { code: error.code, message: error.message }
          : {
              code: "UNREADABLE",
              message: `The file can't be read: ${error instanceof Error ? error.message : String(error)}`,
            },
      ],
    };
  }
  const check = await checkNativeBuildImport({ data: info });
  return {
    step: "checked",
    file,
    info,
    updateStrategy: check.updateStrategy,
    build: check.ok ? check.build : null,
    problems: check.ok ? [] : check.problems,
  };
}

/** Reads `file` and checks it, showing each step. */
const startReading = (file: File, setState: (state: ImportState) => void) => {
  setState({ step: "reading", file });
  void readAndCheck(file).then(setState, (error: unknown) =>
    setState({
      step: "checked",
      file,
      info: null,
      updateStrategy: null,
      build: null,
      problems: [
        {
          code: "UNREADABLE",
          message: `The Console could not check the file: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    }),
  );
};

/**
 * Imports a store artifact built elsewhere (an `.ipa`, `.aab` or `.apk`) as
 * a native build, whose built-in bundle OTAs deployed after it patch from:
 * drop or choose the file, check what it compiled in, then upload it.
 */
export function ImportNativeBuildDialog({
  open,
  file,
  onOpenChange,
}: {
  readonly open: boolean;
  /** A file dropped on the page, which the dialog reads at once. */
  readonly file: File | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [state, setState] = useState<ImportState>({ step: "pick" });
  const abort = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const choose = (next: File) => startReading(next, setState);

  // A file dropped on the page is read at once.
  useEffect(() => {
    if (file !== null) startReading(file, setState);
  }, [file]);
  // Closing the dialog cancels an upload in flight.
  useEffect(() => () => abort.current?.abort(), []);

  const upload = async (target: File, checked: Checked) => {
    const controller = new AbortController();
    abort.current = controller;
    setState({ step: "uploading", file: target, checked, sent: 0 });
    try {
      const result = await uploadNativeBuild(
        target,
        (sent, total) =>
          setState(
            sent >= total
              ? { step: "registering", file: target, checked }
              : { step: "uploading", file: target, checked, sent },
          ),
        controller.signal,
      );
      if (!result.ok) {
        setState({
          step: "failed",
          file: target,
          checked,
          problems: result.problems,
        });
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.nativeBuilds.all,
      });
      onOpenChange(false);
      void navigate({ to: nativeBuildDetailPath(result.nativeBuild.id) });
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === "AbortError") return;
      setState({
        step: "failed",
        file: target,
        checked,
        problems: [
          {
            code: "UNREADABLE",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  };

  const busy = state.step === "uploading" || state.step === "registering";
  // A build already registered: its page is one click away.
  const registeredId =
    state.step === "checked" || state.step === "failed"
      ? state.problems.find(({ nativeBuildId }) => nativeBuildId !== undefined)
          ?.nativeBuildId
      : undefined;

  return (
    <Dialog
      onOpenChange={(next) => {
        // An upload in flight is cancelled by Cancel, not by a stray click.
        if (!next && busy) return;
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a native build</DialogTitle>
          <DialogDescription>
            An .ipa, .aab or .apk built elsewhere, such as by EAS, Xcode Cloud
            or Fastlane. OTAs deployed after it patch from its built-in bundle.
          </DialogDescription>
        </DialogHeader>

        {state.step === "pick" ? (
          <DropZone onFile={choose} />
        ) : state.step === "reading" ? (
          <div
            aria-live="polite"
            className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground"
          >
            <Loader2
              aria-hidden="true"
              className="size-5 animate-spin motion-reduce:animate-none"
            />
            <p>
              Reading{" "}
              <span className="font-medium text-foreground">
                {state.file.name}
              </span>
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {state.step !== "checked" ? (
              <ArtifactValues file={state.file} {...state.checked} />
            ) : state.info !== null ? (
              <ArtifactValues
                build={state.build}
                file={state.file}
                info={state.info}
                updateStrategy={state.updateStrategy}
              />
            ) : null}
            {state.step === "checked" && state.problems.length > 0 ? (
              <Problems
                problems={state.problems}
                title="This build can't be imported"
              />
            ) : null}
            {state.step === "failed" ? (
              <Problems
                problems={state.problems}
                title="The import didn't finish"
              />
            ) : null}
            {state.step === "uploading" || state.step === "registering" ? (
              <UploadProgress
                file={state.file}
                sent={state.step === "uploading" ? state.sent : state.file.size}
                step={state.step}
              />
            ) : null}
          </div>
        )}

        <DialogFooter>
          {registeredId !== undefined ? (
            <Button
              className="min-h-11 sm:min-h-8"
              onClick={() => {
                onOpenChange(false);
                void navigate({ to: nativeBuildDetailPath(registeredId) });
              }}
              variant="outline"
            >
              Open native build
              <ArrowRight data-icon="inline-end" />
            </Button>
          ) : null}
          {state.step === "checked" || state.step === "failed" ? (
            <Button
              className="min-h-11 sm:min-h-8"
              onClick={() => setState({ step: "pick" })}
              variant="outline"
            >
              Choose another file
            </Button>
          ) : null}
          {state.step === "uploading" ? (
            <Button
              className="min-h-11 sm:min-h-8"
              onClick={() => {
                abort.current?.abort();
                setState({ step: "pick" });
              }}
              variant="outline"
            >
              Cancel upload
            </Button>
          ) : null}
          {state.step === "checked" &&
          state.build !== null &&
          state.info !== null &&
          state.updateStrategy !== null ? (
            <Button
              className="min-h-11 sm:min-h-8"
              onClick={() =>
                void upload(state.file, {
                  info: state.info!,
                  updateStrategy: state.updateStrategy!,
                  build: state.build!,
                })
              }
            >
              <Upload data-icon="inline-start" />
              Import build
            </Button>
          ) : null}
          {state.step === "failed" &&
          !state.problems.some(({ code }) => code === "ALREADY_IMPORTED") ? (
            <Button
              className="min-h-11 sm:min-h-8"
              onClick={() => void upload(state.file, state.checked)}
            >
              Try again
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DropZone({ onFile }: { readonly onFile: (file: File) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  return (
    <div
      className={cn(
        "flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground transition-colors",
        over && "border-primary bg-primary/5 text-foreground",
      )}
      data-testid="native-build-drop-zone"
      onDragLeave={() => setOver(false)}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const dropped = event.dataTransfer.files[0];
        if (dropped) onFile(dropped);
      }}
    >
      <FileUp aria-hidden="true" className="size-5" />
      <p className="font-medium text-foreground">Drop a release build here</p>
      <p id={hintId}>.ipa, .aab or .apk, as you upload it to a store</p>
      <Button
        aria-describedby={hintId}
        className="mt-1 min-h-11 sm:min-h-8"
        onClick={() => input.current?.click()}
        variant="outline"
      >
        Choose a file
      </Button>
      <input
        accept={ACCEPT}
        aria-label="Native build file"
        className="sr-only"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = "";
          if (chosen) onFile(chosen);
        }}
        ref={input}
        tabIndex={-1}
        type="file"
      />
    </div>
  );
}

function ArtifactValues({
  file,
  info,
  build,
  updateStrategy,
}: {
  readonly file: File;
  readonly info: NativeArtifactInfo;
  readonly build: ImportableNativeBuild | null;
  readonly updateStrategy: "fingerprint" | "appVersion" | null;
}) {
  const appVersion = textOf(info.appVersion);
  const channel = textOf(info.channel);
  return (
    <dl className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border bg-muted/20 p-3 text-sm">
      <div className="col-span-2 mb-1 flex min-w-0 items-center gap-2">
        {build !== null ? (
          <CheckCircle2
            aria-hidden="true"
            className="size-4 shrink-0 text-primary"
          />
        ) : null}
        <span className="truncate font-medium" title={file.name}>
          {file.name}
        </span>
      </div>
      <ValueRow label="Build">
        {platformLabel(info.platform)} .{info.kind}
        <span className="text-muted-foreground">
          {" "}
          · {formatBytes(file.size)}
        </span>
      </ValueRow>
      <ValueRow label="App" translate="no">
        {info.appId ?? "—"}
      </ValueRow>
      <ValueRow label="Version">
        {appVersion ?? "—"}
        {info.buildNumber === null ? null : (
          <span className="text-muted-foreground"> ({info.buildNumber})</span>
        )}
      </ValueRow>
      <ValueRow label="Channel">
        {channel ?? "production"}
        {channel === null ? (
          <span className="text-muted-foreground"> · none compiled in</span>
        ) : null}
      </ValueRow>
      <ValueRow label="Updates by">
        {updateStrategy === "fingerprint" ? (
          <span className="font-mono text-xs">
            {build?.fingerprintHash?.slice(0, 12) ??
              info.fingerprintCandidates[0]?.slice(0, 12) ??
              "fingerprint"}
          </span>
        ) : updateStrategy === "appVersion" ? (
          `App version ${appVersion ?? ""}`
        ) : (
          "—"
        )}
      </ValueRow>
      <ValueRow label="Min bundle ID">
        {info.minBundleIdCandidates.length === 0 ? (
          "None"
        ) : (
          <span className="font-mono text-xs break-all">
            {info.minBundleIdCandidates.join(", ")}
          </span>
        )}
      </ValueRow>
      <ValueRow label="Built-in bundle">
        {info.builtInBundle === null
          ? "None"
          : formatBytes(info.builtInBundle.byteSize)}
      </ValueRow>
    </dl>
  );
}

function ValueRow({
  label,
  translate,
  children,
}: {
  readonly label: string;
  readonly translate?: "no";
  readonly children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0" translate={translate}>
        {children}
      </dd>
    </>
  );
}

function Problems({
  title,
  problems,
}: {
  readonly title: string;
  readonly problems: readonly NativeArtifactProblem[];
}) {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="flex list-disc flex-col gap-1 pl-4">
          {problems.map((problem) => (
            <li key={`${problem.code}:${problem.message}`}>
              {problem.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function UploadProgress({
  file,
  sent,
  step,
}: {
  readonly file: File;
  readonly sent: number;
  readonly step: "uploading" | "registering";
}) {
  const percent = Math.min(100, Math.round((sent / file.size) * 100));
  return (
    <div aria-live="polite" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium">
          {step === "uploading"
            ? `Uploading ${formatBytes(sent)} of ${formatBytes(file.size)}`
            : "Storing the built-in bundle and registering the build"}
        </span>
        {step === "uploading" ? (
          <span className="text-muted-foreground tabular-nums">{percent}%</span>
        ) : null}
      </div>
      <Progress
        aria-label={step === "uploading" ? "Upload" : "Registration"}
        value={step === "registering" ? null : percent}
      />
      {step === "registering" ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2
            aria-hidden="true"
            className="size-3.5 animate-spin motion-reduce:animate-none"
          />
          The Console reads the build again, then stores it.
        </p>
      ) : null}
    </div>
  );
}
