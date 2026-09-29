/**
 * Hot Updater's own lint rules, loaded by .oxlintrc.json as an oxlint JS plugin.
 *
 * no-filtered-find-many: rows that `findMany` read and code then filters are
 * rows the request read but did not return. The PRD's read rules say a read
 * goes through the declared index that selects its rows (a derived key when
 * no field does), so filtering `findMany` results is banned outside tests.
 */
const FILTERS = new Set(["filter", "find", "findLast"]);

const isFindMany = (node) => {
  if (node?.type === "AwaitExpression") return isFindMany(node.argument);
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property.name === "findMany"
  );
};

const noFilteredFindMany = {
  meta: {
    type: "problem",
    docs: { description: "Ban filtering the rows `findMany` returns." },
    messages: {
      filtered:
        "Filtering findMany results reads rows the request does not return. Read through an index that selects them, or a derived key.",
    },
  },
  create(context) {
    if (/\.(spec|test)\.[cm]?tsx?$/.test(context.filename)) return {};
    // Names bound to a findMany page, and to the rows destructured from one.
    const pages = new Set();
    const rows = new Set();
    return {
      VariableDeclarator(node) {
        if (!isFindMany(node.init)) return;
        if (node.id.type === "Identifier") pages.add(node.id.name);
        if (node.id.type !== "ObjectPattern") return;
        for (const property of node.id.properties) {
          if (
            property.type === "Property" &&
            property.key.type === "Identifier" &&
            property.key.name === "rows" &&
            property.value.type === "Identifier"
          ) {
            rows.add(property.value.name);
          }
        }
      },
      CallExpression(node) {
        const { callee } = node;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          !FILTERS.has(callee.property.name)
        ) {
          return;
        }
        const target = callee.object;
        const pageRows =
          target.type === "MemberExpression" &&
          !target.computed &&
          target.property.name === "rows" &&
          (isFindMany(target.object) ||
            (target.object.type === "Identifier" &&
              pages.has(target.object.name)));
        const destructured =
          target.type === "Identifier" && rows.has(target.name);
        if (pageRows || destructured) {
          context.report({ node, messageId: "filtered" });
        }
      },
    };
  },
};

export default {
  meta: { name: "hot-updater" },
  rules: { "no-filtered-find-many": noFilteredFindMany },
};
