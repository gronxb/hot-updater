import { Button } from "@/components/ui/button";
import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Bundle } from "@hot-updater/plugin-core";
import { createAsync } from "@solidjs/router";
import { createForm } from "@tanstack/solid-form";
import semverValid from "semver/ranges/valid";
import { Show, createMemo, createSignal } from "solid-js";
import { LoaderCircle } from "lucide-solid";

interface EditBundleSheetFormProps {
  bundle: Bundle;
  onEditSuccess: () => void;
}

const EditBundleSheetForm = ({
  bundle,
  onEditSuccess,
}: EditBundleSheetFormProps) => {
  const config = createAsync(() =>
    api.getConfig.$get().then((res) => res.json()),
  );
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const gitUrl = createMemo(() => config()?.console?.gitUrl);
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
      } catch {
        console.error("error");
      } finally {
        setIsSubmitting(false);
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

      <Button type="submit" class="mt-4" disabled={!isValid()}>
        {isSubmitting() ? <LoaderCircle class="animate-spin" /> : "Save"}
      </Button>

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

export interface EditBundleSheetContentProps {
  bundleId: string;
  onClose: () => void;
}

export const EditBundleSheetContent = ({
  bundleId,
  onClose,
}: EditBundleSheetContentProps) => {
  const bundle = createAsync(() =>
    api.getBundleById.$post({ json: { bundleId } }).then((res) => res.json()),
  );

  return (
    <SheetContent class="flex flex-col h-full">
      <SheetHeader class="mb-4">
        <SheetTitle>Edit {bundle()?.id}</SheetTitle>
      </SheetHeader>

      <Show
        when={bundle()}
        fallback={
          <SheetDescription>
            No update bundle found for bundle id {bundleId}
          </SheetDescription>
        }
      >
        {(bundle) => {
          return (
            <EditBundleSheetForm bundle={bundle()} onEditSuccess={onClose} />
          );
        }}
      </Show>
    </SheetContent>
  );
};
