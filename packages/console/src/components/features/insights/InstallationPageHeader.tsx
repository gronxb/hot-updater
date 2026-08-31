import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";

export function InstallationSearchPanel({
  draftQuery,
  onDraftQueryChange,
  onSubmit,
  onClear,
}: {
  readonly draftQuery: string;
  readonly onDraftQueryChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onClear: () => void;
}) {
  return (
    <form
      aria-label="Find installation"
      onSubmit={(event) => {
        event.preventDefault();
        if (draftQuery.trim()) onSubmit();
      }}
      role="search"
    >
      <Field className="gap-2">
        <FieldLabel className="sr-only" htmlFor="installation-history-search">
          User ID or install ID
        </FieldLabel>
        <div className="flex flex-wrap gap-2">
          <InputGroup className="h-8 w-auto min-w-0 flex-1 basis-44">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              aria-describedby="installation-lookup-description"
              autoComplete="off"
              id="installation-history-search"
              maxLength={1024}
              name="installation"
              onChange={(event) => onDraftQueryChange(event.target.value)}
              placeholder="User ID or install ID"
              spellCheck={false}
              type="search"
              value={draftQuery}
            />
            {draftQuery.length > 0 ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  aria-label="Clear installation lookup"
                  onClick={onClear}
                  size="icon-xs"
                >
                  <X aria-hidden="true" />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          <Button
            disabled={draftQuery.trim().length === 0}
            size="lg"
            type="submit"
            variant="outline"
          >
            Find installation
          </Button>
        </div>
        <FieldDescription id="installation-lookup-description">
          Opens installation history for a user ID or install ID.
        </FieldDescription>
      </Field>
    </form>
  );
}

export function InstallationResultsSkeleton() {
  return (
    <div className="grid items-stretch gap-6 lg:min-h-96 lg:grid-cols-[minmax(18rem,20rem)_minmax(0,1fr)]">
      <Skeleton className="h-64 w-full lg:h-full" />
      <Skeleton className="h-64 w-full lg:h-full" />
    </div>
  );
}
