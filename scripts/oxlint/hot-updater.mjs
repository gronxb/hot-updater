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

const BUNDLE_ID = /bundle_?ids?$/i;
const RELEASE_ID = /release_?ids?$/i;

const WRAPPERS = new Set([
  "AwaitExpression",
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

/** The kind a name says it holds: `bundleId`-like, `releaseId`-like, or none. */
const kindOfName = (name) => {
  if (typeof name !== "string") return null;
  if (BUNDLE_ID.test(name)) return "bundle";
  if (RELEASE_ID.test(name)) return "release";
  return null;
};

/** The last name in `a`, `a.b`, `a?.b`, or `a.b[0]`. */
const tailName = (node) => {
  while (node && WRAPPERS.has(node.type)) {
    node = node.expression ?? node.argument;
  }
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "MemberExpression") {
    return node.computed ? tailName(node.object) : node.property.name;
  }
  return null;
};

const keyName = (key) => {
  if (key?.type === "Identifier") return key.name;
  if (key?.type === "Literal" && typeof key.value === "string") {
    return key.value;
  }
  return null;
};

/**
 * The kinds of ID an expression is named as holding: a `bundleId`- or
 * `releaseId`-like name, `<…release…>.id` or `<…bundle…>.id`, through `??`,
 * `||`, `&&` and `?:`. Calls say nothing: `getBundleId()` returns a release.
 */
const kindsOf = (node, kinds = new Set()) => {
  while (node && WRAPPERS.has(node.type)) {
    node = node.expression ?? node.argument;
  }
  if (!node) return kinds;
  if (node.type === "LogicalExpression") {
    kindsOf(node.left, kinds);
    kindsOf(node.right, kinds);
  } else if (node.type === "ConditionalExpression") {
    kindsOf(node.consequent, kinds);
    kindsOf(node.alternate, kinds);
  } else if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.name === "id"
  ) {
    const owner = tailName(node.object) ?? "";
    if (/release/i.test(owner)) kinds.add("release");
    else if (/bundle/i.test(owner)) kinds.add("bundle");
  } else {
    const kind = kindOfName(tailName(node));
    if (kind) kinds.add(kind);
  }
  return kinds;
};

const idNaming = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep artifact IDs in bundleId names and release IDs in releaseId names.",
    },
    messages: {
      mixed:
        "`{{target}}` takes a {{source}} ID. In code, bundleId names the artifact and releaseId the release (the ID users call the bundle ID); rename one side.",
    },
  },
  create(context) {
    const check = (node, target, source) => {
      const kind = kindOfName(target);
      if (!kind) return;
      const other = kind === "bundle" ? "release" : "bundle";
      if (kindsOf(source).has(other)) {
        context.report({
          node,
          messageId: "mixed",
          data: { target, source: other },
        });
      }
    };
    return {
      ObjectExpression(node) {
        for (const property of node.properties) {
          if (property.type !== "Property" || property.computed) continue;
          if (property.kind !== "init" || property.method) continue;
          check(property, keyName(property.key), property.value);
        }
      },
      ObjectPattern(node) {
        // `{ bundleId: releaseId }` binds `releaseId` from `.bundleId`.
        for (const property of node.properties) {
          if (property.type !== "Property" || property.computed) continue;
          let { value } = property;
          if (value.type === "AssignmentPattern") value = value.left;
          if (value.type !== "Identifier") continue;
          check(property, value.name, property.key);
        }
      },
      JSXAttribute(node) {
        if (node.value?.type !== "JSXExpressionContainer") return;
        if (node.name.type !== "JSXIdentifier") return;
        check(node, node.name.name, node.value.expression);
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.init) {
          check(node, node.id.name, node.init);
        }
      },
      AssignmentExpression(node) {
        check(node, tailName(node.left), node.right);
      },
      AssignmentPattern(node) {
        if (node.left.type === "Identifier") {
          check(node, node.left.name, node.right);
        }
      },
      PropertyDefinition(node) {
        if (!node.computed && node.value) {
          check(node, keyName(node.key), node.value);
        }
      },
    };
  },
};

export default {
  meta: { name: "hot-updater" },
  rules: {
    "id-naming": idNaming,
    "no-filtered-find-many": noFilteredFindMany,
  },
};
