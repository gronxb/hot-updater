import { createFileRoute, notFound } from "@tanstack/react-router";
import { DocsPage, DocsBody, DocsDescription, DocsTitle } from "fumadocs-ui/page";
import { notFound as fumadocsNotFound } from "fumadocs-core/server";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { loader } from "~/lib/source";

export const Route = createFileRoute("/docs/$")({
  loader: async ({ params }) => {
    const page = loader.getPage([params["*"]]);

    if (!page) {
      throw notFound();
    }

    const MDX = page.data.body;

    return {
      page,
      MDX,
    };
  },
  component: DocsPageComponent,
  notFoundComponent: () => {
    return <div>Documentation page not found</div>;
  },
});

function DocsPageComponent() {
  const { page, MDX } = Route.useLoaderData();

  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
      lastUpdate={page.data.lastModified}
      editOnGithub={{
        owner: "gronxb",
        repo: "hot-updater",
        path: `docs/content/docs/${page.file.path}`,
      }}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents }} />
      </DocsBody>
    </DocsPage>
  );
}
