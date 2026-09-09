import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins/rehype-code";

export const codeSnippetTransformers = [
  ...(rehypeCodeDefaultOptions.transformers ?? []),
  {
    name: "hot-updater:copy-applied-diff",
    enforce: "post",
    code(node) {
      for (const line of node.children) {
        if (line.type !== "element") continue;
        const classes = line.properties.class;
        if (
          Array.isArray(classes) &&
          classes.includes("diff") &&
          classes.includes("remove")
        ) {
          // Fumadocs omits this class when copying a code block.
          this.addClassToHast(line, "nd-copy-ignore");
        }
      }
    },
  },
] satisfies NonNullable<typeof rehypeCodeDefaultOptions.transformers>;
