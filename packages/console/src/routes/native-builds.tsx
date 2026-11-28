import { createFileRoute } from "@tanstack/react-router";

import { NativeBuildsPage } from "@/components/features/native-builds/NativeBuildsPage";

import { validateNativeBuildsSearch } from "./-native-builds-search";

export const Route = createFileRoute("/native-builds")({
  component: NativeBuildsRoute,
  validateSearch: validateNativeBuildsSearch,
});

function NativeBuildsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <NativeBuildsPage
      onSearchChange={(next) => void navigate({ search: next })}
      search={search}
    />
  );
}
