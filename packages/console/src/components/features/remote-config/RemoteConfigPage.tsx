import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  AlertTriangle,
  RefreshCw,
  SlidersHorizontal,
  Undo2,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRemoteConfigQuery } from "@/lib/remote-config-api";
import {
  isSameTemplate,
  moveCondition,
  removeCondition,
  removeParameter,
  type RemoteConfigTemplate,
  upsertCondition,
  upsertParameter,
} from "@/lib/remote-config-draft";

import { ConditionsCard } from "./ConditionsCard";
import { ParametersCard } from "./ParametersCard";
import { PreviewCard } from "./PreviewCard";
import { PublishDialog } from "./PublishDialog";
import { VersionsCard } from "./VersionsCard";

dayjs.extend(relativeTime);

export type RemoteConfigTab =
  | "parameters"
  | "conditions"
  | "preview"
  | "versions";

export const REMOTE_CONFIG_TABS: readonly RemoteConfigTab[] = [
  "parameters",
  "conditions",
  "preview",
  "versions",
];

/** Unpublished edits, and the version they started from. */
interface Draft {
  readonly baseVersion: number;
  readonly template: RemoteConfigTemplate;
}

/**
 * Remote Config: edit the parameters and conditions of a draft, preview what
 * a device gets, publish the draft as a version, and roll back to an earlier
 * one.
 */
export function RemoteConfigPage({
  tab,
  onTabChange,
}: {
  readonly tab: RemoteConfigTab;
  readonly onTabChange: (tab: RemoteConfigTab) => void;
}) {
  const active = useRemoteConfigQuery();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [publishing, setPublishing] = useState(false);
  const published = active.data;
  const template = draft?.template ?? published?.template;
  const dirty =
    draft !== null &&
    published !== undefined &&
    !isSameTemplate(draft.template, published.template);
  const stale =
    dirty && published !== undefined && draft.baseVersion !== published.version;

  // Leaving the page loses the draft; the browser asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const edit = (
    change: (template: RemoteConfigTemplate) => RemoteConfigTemplate,
  ) => {
    if (published === undefined || template === undefined) return;
    setDraft({
      baseVersion: draft?.baseVersion ?? published.version,
      template: change(template),
    });
  };

  const counts = {
    parameters:
      template === undefined ? null : Object.keys(template.parameters).length,
    conditions: template?.conditions.length ?? null,
  };

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background px-3 py-3 sm:min-h-12 sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
        <SidebarTrigger className="-ml-1 size-11 lg:size-7" />
        <div className="flex items-center gap-1.5">
          <SlidersHorizontal
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
          />
          <h1 className="text-sm font-medium">Remote Config</h1>
        </div>
        {published === undefined ? null : (
          <p className="text-xs text-muted-foreground">
            {published.version === 0 ? (
              "Nothing published yet"
            ) : (
              <>
                Version {published.version}
                {published.updatedAtMs === null ? null : (
                  <>
                    {" · published "}
                    <time
                      dateTime={new Date(published.updatedAtMs).toISOString()}
                      title={dayjs(published.updatedAtMs).format(
                        "YYYY/MM/DD HH:mm:ss",
                      )}
                    >
                      {dayjs(published.updatedAtMs).fromNow()}
                    </time>
                  </>
                )}
              </>
            )}
          </p>
        )}
        {dirty ? (
          <div className="ml-auto flex items-center gap-2">
            <Badge className="hidden sm:inline-flex" variant="secondary">
              Unpublished changes
            </Badge>
            <Button
              className="min-h-11 lg:min-h-7"
              onClick={() => setDraft(null)}
              variant="ghost"
            >
              <Undo2 data-icon="inline-start" />
              Discard
            </Button>
            <Button
              className="min-h-11 lg:min-h-7"
              onClick={() => setPublishing(true)}
            >
              <Upload data-icon="inline-start" />
              Publish changes
            </Button>
          </div>
        ) : null}
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          {active.isError ? (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Remote Config couldn't be loaded</AlertTitle>
              <AlertDescription>
                Check the connection and try again.
              </AlertDescription>
              <AlertAction>
                <Button
                  onClick={() => void active.refetch()}
                  size="xs"
                  variant="outline"
                >
                  <RefreshCw data-icon="inline-start" />
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ) : null}
          {stale && draft !== null && published !== undefined ? (
            <Alert>
              <AlertTriangle />
              <AlertTitle>
                Version {published.version} was published while you edited
              </AlertTitle>
              <AlertDescription>
                Your draft started from version {draft.baseVersion}. Discard it
                to review version {published.version}, or publish yours after
                it.
              </AlertDescription>
              <AlertAction>
                <Button
                  onClick={() => setDraft(null)}
                  size="xs"
                  variant="outline"
                >
                  Load version {published.version}
                </Button>
              </AlertAction>
            </Alert>
          ) : null}
          <Tabs
            onValueChange={(value) => onTabChange(value as RemoteConfigTab)}
            value={tab}
          >
            <TabsList
              aria-label="Remote Config views"
              className="max-w-full group-data-horizontal/tabs:h-auto"
            >
              {(
                [
                  ["parameters", "Parameters", counts.parameters],
                  ["conditions", "Conditions", counts.conditions],
                  ["preview", "Preview", null],
                  ["versions", "Versions", null],
                ] as const
              ).map(([value, label, count]) => (
                <TabsTrigger
                  className="min-h-11 flex-none px-3 lg:min-h-7"
                  key={value}
                  value={value}
                >
                  {label}
                  {count === null ? null : (
                    <span className="tabular-nums text-muted-foreground">
                      {count}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
            {template === undefined || published === undefined ? (
              active.isError ? null : (
                <div className="flex flex-col gap-3 pt-2">
                  <span className="sr-only">Loading Remote Config</span>
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                </div>
              )
            ) : (
              <>
                <TabsContent value="parameters">
                  <ParametersCard
                    onAddCondition={(condition) =>
                      edit((current) =>
                        upsertCondition(current, null, condition),
                      )
                    }
                    onRemoveParameter={(key) =>
                      edit((current) => removeParameter(current, key))
                    }
                    onSaveParameter={(previousKey, key, parameter) =>
                      edit((current) =>
                        upsertParameter(current, previousKey, key, parameter),
                      )
                    }
                    template={template}
                  />
                </TabsContent>
                <TabsContent value="conditions">
                  <ConditionsCard
                    onMoveCondition={(index, offset) =>
                      edit((current) => moveCondition(current, index, offset))
                    }
                    onRemoveCondition={(name) =>
                      edit((current) => removeCondition(current, name))
                    }
                    onSaveCondition={(previousName, condition) =>
                      edit((current) =>
                        upsertCondition(current, previousName, condition),
                      )
                    }
                    template={template}
                  />
                </TabsContent>
                <TabsContent value="preview">
                  <PreviewCard isDraft={dirty} template={template} />
                </TabsContent>
                <TabsContent value="versions">
                  <VersionsCard
                    activeVersion={published.version}
                    hasDraft={dirty}
                    onRolledBack={() => setDraft(null)}
                    onStartEditing={() => onTabChange("parameters")}
                  />
                </TabsContent>
              </>
            )}
          </Tabs>
        </div>
      </div>
      {published !== undefined && draft !== null ? (
        <PublishDialog
          base={published.template}
          baseVersion={draft.baseVersion}
          draft={draft.template}
          onLoadLatest={() => setDraft(null)}
          onOpenChange={setPublishing}
          onPublishOver={(version) =>
            setDraft({ ...draft, baseVersion: version })
          }
          onPublished={() => setDraft(null)}
          open={publishing}
        />
      ) : null}
    </div>
  );
}
