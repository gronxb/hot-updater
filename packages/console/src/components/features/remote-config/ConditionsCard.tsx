import {
  ArrowDown,
  ArrowUp,
  GitBranch,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { type MouseEvent, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  describeRule,
  parametersUsing,
  type RemoteConfigCondition,
  type RemoteConfigTemplate,
} from "@/lib/remote-config-draft";

import { ConditionDialog } from "./ConditionDialog";

/** The draft's conditions in priority order: the first match decides a value. */
export function ConditionsCard({
  template,
  onSaveCondition,
  onRemoveCondition,
  onMoveCondition,
}: {
  readonly template: RemoteConfigTemplate;
  readonly onSaveCondition: (
    previousName: string | null,
    condition: RemoteConfigCondition,
  ) => void;
  readonly onRemoveCondition: (name: string) => void;
  readonly onMoveCondition: (index: number, offset: -1 | 1) => void;
}) {
  const [editing, setEditing] = useState<{
    readonly name: string | null;
  } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const { conditions } = template;
  const editingName = editing?.name ?? null;
  const removingUsers =
    removing === null ? [] : parametersUsing(template, removing);

  const remove = (name: string) => {
    if (parametersUsing(template, name).length === 0) onRemoveCondition(name);
    else setRemoving(name);
  };

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <CardTitle className="text-sm">
            <h2>Conditions</h2>
          </CardTitle>
          <CardDescription className="text-xs">
            Listed by priority: when several match a device, the first wins.
          </CardDescription>
        </div>
        <Button
          className="min-h-11 sm:min-h-7"
          onClick={() => setEditing({ name: null })}
        >
          <Plus data-icon="inline-start" />
          Add condition
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {conditions.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GitBranch />
              </EmptyMedia>
              <EmptyTitle>No conditions</EmptyTitle>
              <EmptyDescription>
                Add a condition to give some devices other values: a platform,
                channel, app version range, cohort, or a share of installs.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                className="min-h-11 sm:min-h-7"
                onClick={() => setEditing({ name: null })}
              >
                <Plus data-icon="inline-start" />
                Add condition
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ol aria-label="Conditions" className="divide-y">
            {conditions.map((condition, index) => {
              const users = parametersUsing(template, condition.name);
              return (
                <li
                  className="grid gap-3 px-4 py-3 sm:px-6 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center"
                  key={condition.name}
                >
                  <span
                    aria-label={`Priority ${index + 1}`}
                    className="flex size-6 items-center justify-center rounded-md bg-muted text-xs font-medium tabular-nums"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {condition.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {condition.rules.map(describeRule).join(" · ")}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {users.length === 0
                        ? "No parameter uses it yet"
                        : `Sets ${users.length === 1 ? "1 parameter" : `${users.length} parameters`}: ${users.slice(0, 3).join(", ")}${users.length > 3 ? "…" : ""}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1 md:justify-end">
                    <Button
                      aria-label={`Move ${condition.name} up`}
                      className="size-11 md:size-7"
                      disabled={index === 0}
                      onClick={() => onMoveCondition(index, -1)}
                      size="icon"
                      variant="ghost"
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      aria-label={`Move ${condition.name} down`}
                      className="size-11 md:size-7"
                      disabled={index === conditions.length - 1}
                      onClick={() => onMoveCondition(index, 1)}
                      size="icon"
                      variant="ghost"
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      aria-label={`Edit ${condition.name}`}
                      className="min-h-11 md:min-h-7"
                      onClick={() => setEditing({ name: condition.name })}
                      size="sm"
                      variant="outline"
                    >
                      <Pencil data-icon="inline-start" />
                      Edit
                    </Button>
                    <Button
                      aria-label={`Delete ${condition.name}`}
                      className="size-11 md:size-7"
                      onClick={() => remove(condition.name)}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
      <ConditionDialog
        condition={
          editingName === null
            ? null
            : (conditions.find(({ name }) => name === editingName) ?? null)
        }
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSave={(condition) => onSaveCondition(editingName, condition)}
        open={editing !== null}
        takenNames={conditions
          .map(({ name }) => name)
          .filter((name) => name !== editingName)}
      />
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        open={removing !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removingUsers.length === 1
                ? "1 parameter has a value for it"
                : `${removingUsers.length} parameters have a value for it`}{" "}
              ({removingUsers.join(", ")}). Those values are removed too, so
              matching devices get the default value after you publish.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                event.preventDefault();
                if (removing !== null) onRemoveCondition(removing);
                setRemoving(null);
              }}
              variant="destructive"
            >
              Delete condition
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
