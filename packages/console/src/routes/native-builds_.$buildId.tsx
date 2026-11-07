import { createFileRoute } from "@tanstack/react-router";

import { NativeBuildDetailPage } from "@/components/features/native-builds/NativeBuildDetailPage";

import { validateNativeBuildDetailSearch } from "./-native-builds-search";

export const Route = createFileRoute("/native-builds_/$buildId")({
  component: NativeBuildDetailRoute,
  validateSearch: validateNativeBuildDetailSearch,
});

function NativeBuildDetailRoute() {
  const { buildId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <NativeBuildDetailPage
      buildId={buildId}
      onSearchChange={(next) => void navigate({ search: next, replace: true })}
      search={search}
    />
  );
}
