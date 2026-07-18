import { Link } from "@tanstack/react-router";
import { ArrowLeft, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

export function InstallationPageHeader() {
  return (
    <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-background px-3 py-3 sm:min-h-12 sm:flex-nowrap sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
      <SidebarTrigger className="-ml-1" />
      <Button asChild size="sm" variant="ghost">
        <Link to="/analytics">
          <ArrowLeft aria-hidden="true" data-icon="inline-start" />
          Back to Analytics
        </Link>
      </Button>
      <Separator className="mx-1 hidden h-4 sm:block" orientation="vertical" />
      <div className="basis-full pl-9 sm:basis-auto sm:pl-0">
        <h1 className="text-sm font-medium">Installation history</h1>
        <p className="text-xs text-muted-foreground">
          Review the last known bundle and recorded changes.
        </p>
      </div>
    </header>
  );
}

export function InstallationSearchPanel({
  draftQuery,
  onDraftQueryChange,
  onSubmit,
  onClear,
  hasQuery,
}: {
  readonly draftQuery: string;
  readonly onDraftQueryChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onClear: () => void;
  readonly hasQuery: boolean;
}) {
  return (
    <Card>
      <CardHeader className="p-5 pb-4">
        <CardTitle className="text-sm font-medium">
          <h2>Find an installation</h2>
        </CardTitle>
        <CardDescription>
          Enter either identifier to open its recorded bundle history.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-5 pt-0">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
          role="search"
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="installation-history-search">
                User ID or install ID
              </FieldLabel>
              <div className="flex flex-col gap-2 sm:flex-row">
                <InputGroup className="h-8 sm:max-w-2xl">
                  <InputGroupAddon>
                    <Search aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="installation-history-search"
                    onChange={(event) => onDraftQueryChange(event.target.value)}
                    placeholder="Enter a user ID or install ID"
                    type="search"
                    value={draftQuery}
                  />
                  {draftQuery.length > 0 || hasQuery ? (
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        aria-label="Clear search"
                        onClick={onClear}
                        size="icon-xs"
                      >
                        <X aria-hidden="true" />
                      </InputGroupButton>
                    </InputGroupAddon>
                  ) : null}
                </InputGroup>
                <Button size="lg" type="submit">
                  <Search aria-hidden="true" data-icon="inline-start" />
                  Search history
                </Button>
              </div>
              <FieldDescription>
                A user ID may return more than one installation. An install ID
                opens one installation directly.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

export function InstallationResultsSkeleton() {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.35fr)]">
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
