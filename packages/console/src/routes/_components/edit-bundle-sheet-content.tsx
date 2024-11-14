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
import type { Bundle } from "@hot-updater/plugin-core";
import { createAsync } from "@solidjs/router";
import { createForm } from "@tanstack/solid-form";

interface EditBundleSheetFormProps {
  bundle: Bundle;
  onEditSuccess: () => void;
}

const EditBundleSheetForm = ({
  bundle,
  onEditSuccess,
}: EditBundleSheetFormProps) => {
  const form = createForm(() => ({
    defaultValues: {
      description: bundle.description,
      targetVersion: bundle.targetVersion,
      enabled: bundle.enabled,
      forceUpdate: bundle.forceUpdate,
    },
    onSubmit: async ({ value }) => {
      // Do something with form data
      await api.updateBundle.$post({
        json: {
          targetBundleId: bundle.bundleId,
          bundle: value,
        },
      });
      onEditSuccess();
    },
  }));

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
          <TextFieldLabel for="description">Description</TextFieldLabel>
          <form.Field name="description">
            {(field) => (
              <TextFieldInput
                type="text"
                id="description"
                placeholder="Description"
                name={field().name}
                value={field().state.value}
                onBlur={field().handleBlur}
                onInput={(e) => field().handleChange(e.currentTarget.value)}
              />
            )}
          </form.Field>
        </TextField>
      </div>

      <div>
        <TextField class="grid w-full max-w-sm items-center gap-1.5">
          <TextFieldLabel for="targetVersion">Target Version</TextFieldLabel>
          <form.Field name="targetVersion">
            {(field) => (
              <TextFieldInput
                type="text"
                id="targetVersion"
                placeholder="Target Version"
                name={field().name}
                value={field().state.value}
                onBlur={field().handleBlur}
                onInput={(e) => field().handleChange(e.currentTarget.value)}
              />
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
          <form.Field name="forceUpdate">
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
      <Button type="submit" class="mt-4">
        Save
      </Button>
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
        <SheetTitle>Edit {bundle()?.bundleId}</SheetTitle>
      </SheetHeader>

      {bundle() ? (
        <EditBundleSheetForm bundle={bundle()!} onEditSuccess={onClose} />
      ) : (
        <SheetDescription>
          No update bundle found for bundle id {bundleId}
        </SheetDescription>
      )}
    </SheetContent>
  );
};
