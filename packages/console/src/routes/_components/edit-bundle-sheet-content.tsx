import { Button } from "@/components/ui/button";
import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "@/components/ui/text-field";
import { api, createBundleQuery, createConfigQuery } from "@/lib/api";
import { cn } from "@/lib/utils";

import type { Bundle } from "@hot-updater/plugin-core";
import { createForm } from "@tanstack/solid-form";
import { useQueryClient } from "@tanstack/solid-query";
import { LoaderCircle } from "lucide-solid";
import semverValid from "semver/ranges/valid";
import { Show, createMemo, createSignal } from "solid-js";
import { toast } from "solid-sonner";

export interface EditBundleSheetContentProps {
  bundleId: string;
  onClose: () => void;
}

export const EditBundleSheetContent = ({
  bundleId,
  onClose,
}: EditBundleSheetContentProps) => {
  const data = createBundleQuery(bundleId);

  return (
    <SheetContent class="flex flex-col h-full">
      <SheetHeader class="mb-4">
        <SheetTitle>Edit {bundleId}</SheetTitle>
      </SheetHeader>

      <Show
        when={data.data}
        fallback={
          data.isFetched ? (
            <SheetDescription>
              No update bundle found for bundle id {bundleId}
            </SheetDescription>
          ) : (
            <Skeleton height={374} radius={10} />
          )
        }
      >
        {(bundle) => (
          <EditBundleSheetForm bundle={bundle()} onEditSuccess={onClose} />
        )}
      </Show>
    </SheetContent>
  );
};

interface EditBundleSheetFormProps {
  bundle: Bundle;
  onEditSuccess: () => void;
}

const EditBundleSheetForm = ({
  bundle,
  onEditSuccess,
}: EditBundleSheetFormProps) => {
  const queryClient = useQueryClient();
  const config = createConfigQuery();

  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const gitUrl = createMemo(() => config.data?.console?.gitUrl ?? null);
  const gitCommitHash = createMemo(() => bundle.gitCommitHash);

  const form = createForm(() => ({
    defaultValues: {
      message: bundle.message,
      targetAppVersion: bundle.targetAppVersion,
      enabled: bundle.enabled,
      shouldForceUpdate: bundle.shouldForceUpdate,
    } as Partial<Bundle>,
    onSubmit: async ({ value }) => {
      setIsSubmitting(true);
      try {
        await api.updateBundle.$post({
          json: {
            targetBundleId: bundle.id,
            bundle: value,
          },
        });
      } catch (e) {
        if (e instanceof Error) {
          toast(e.message);
        }
      } finally {
        setIsSubmitting(false);
        queryClient.invalidateQueries({ queryKey: ["getBundle", bundle.id] });
        queryClient.invalidateQueries({ queryKey: ["getBundles"] });
        onEditSuccess();
      }
    },
  }));

  const isValid = form.useStore((state) => state.isValid);

  return (
    <form
      class="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <div>
        <TextField class="grid w-full max-w-sm items-center gap-1.5">
          <TextFieldLabel for="message">Message</TextFieldLabel>
          <form.Field name="message">
            {(field) => (
              <TextFieldInput
                type="text"
                id="message"
                placeholder="Message"
                name={field().name}
                value={field().state.value ?? ""}
                onBlur={field().handleBlur}
                onInput={(e) => field().handleChange(e.currentTarget.value)}
              />
            )}
          </form.Field>
        </TextField>
      </div>

      <div>
        <TextField class="grid w-full max-w-sm items-center gap-1.5">
          <TextFieldLabel for="targetAppVersion">
            Target App Version
          </TextFieldLabel>
          <form.Field
            name="targetAppVersion"
            validators={{
              onChange: ({ value }) => {
                if (value?.length === 0 || !semverValid(value)) {
                  return "Invalid target app version";
                }

                return undefined;
              },
            }}
          >
            {(field) => (
              <>
                <TextFieldInput
                  type="text"
                  id="targetAppVersion"
                  class={cn(
                    field().state.meta.errors.length > 0 &&
                      "border-red-500 focus-visible:ring-red-500",
                  )}
                  placeholder="Target App Version"
                  name={field().name}
                  value={field().state.value ?? ""}
                  onBlur={field().handleBlur}
                  onInput={(e) => field().handleChange(e.currentTarget.value)}
                />
                {field().state.meta.errors.length > 0 ? (
                  <em class="text-xs text-red-500">
                    {field().state.meta.errors.join(", ")}
                  </em>
                ) : (
                  <em class="text-xs text-muted-foreground">
                    {semverValid(field().state.value)}
                  </em>
                )}
              </>
            )}
          </form.Field>
        </TextField>
      </div>

      <div>
        <div class="flex items-center space-x-2">
          <form.Field name="enabled">
            {(field) => (
              <Switch
                class="flex items-center space-x-2"
                checked={field().state.value}
                name={field().name}
                onChange={(value) => field().handleChange(value)}
              >
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
                <SwitchLabel>Enabled</SwitchLabel>
              </Switch>
            )}
          </form.Field>
        </div>
        <p class="text-xs text-muted-foreground mt-[2px]">
          When disabled, this update will not be available to your users.
        </p>
      </div>

      <div>
        <div class="flex items-center space-x-2">
          <form.Field name="shouldForceUpdate">
            {(field) => (
              <Switch
                class="flex items-center space-x-2"
                checked={field().state.value}
                name={field().name}
                onChange={(value) => field().handleChange(value)}
              >
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
                <SwitchLabel>Force Update</SwitchLabel>
              </Switch>
            )}
          </form.Field>
        </div>
        <p class="text-xs text-muted-foreground mt-[2px]">
          When enabled, this update will require users to update before
          continuing to use the application.
        </p>
      </div>

      <Show
        when={!isSubmitting()}
        fallback={
          <Button type="submit" class="mt-4" disabled>
            <LoaderCircle class="animate-spin" />
          </Button>
        }
      >
        <Button type="submit" class="mt-4" disabled={!isValid()}>
          Save
        </Button>
      </Show>

      <div class="flex justify-end">
        <Show when={gitCommitHash()}>
          {(gitCommitHash) =>
            gitUrl() ? (
              <a
                href={`${gitUrl()}/commit/${gitCommitHash}`}
                target="_blank"
                rel="noreferrer"
                class="text-xs text-muted-foreground"
              >
                Commit Hash: {gitCommitHash().slice(0, 8)}
              </a>
            ) : (
              <p class="text-xs text-muted-foreground">
                Commit Hash: {gitCommitHash().slice(0, 8)}
              </p>
            )
          }
        </Show>
      </div>
    </form>
  );
};
