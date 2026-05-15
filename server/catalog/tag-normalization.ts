const TAG_ALIASES = new Map(
  [
    ["access", "accessibility"],
    ["app framework", "app-framework"],
    ["baas", "backend-as-a-service"],
    ["build", "build-tool"],
    ["component", "component-library"],
    ["components", "component-library"],
    ["content management system", "content-management-system"],
    ["cms", "content-management-system"],
    ["css lib", "css-library"],
    ["css-lib", "css-library"],
    ["db", "database"],
    ["devtool", "developer-tool"],
    ["front end", "front-end"],
    ["frontend", "front-end"],
    ["frontend framework", "front-end-framework"],
    ["front-end framework", "front-end-framework"],
    ["full stack", "fullstack"],
    ["full stack framework", "fullstack-framework"],
    ["fullstack framework", "fullstack-framework"],
    ["gh", "github"],
    ["js", "javascript"],
    ["material", "material-design"],
    ["meta framework", "meta-framework"],
    ["node js", "nodejs"],
    ["node.js", "nodejs"],
    ["react native", "react-native"],
    ["server side rendering", "server-side-rendering"],
    ["ssg", "static-site-generator"],
    ["test framework", "testing-framework"],
    ["test-framework", "testing-framework"],
    ["typescript sdk", "typescript-sdk"],
    ["ui", "component-library"],
  ].map(([alias, tagId]) => [normalizeTagKey(alias), tagId])
)

export function normalizeTagValue(value: string) {
  const normalizedKey = normalizeTagKey(value)

  if (!normalizedKey) {
    return undefined
  }

  return TAG_ALIASES.get(normalizedKey) ?? normalizedKey
}

export function createTagLabel(tagId: string) {
  return tagId
    .split("-")
    .flatMap((segment) => (segment ? [segment.toLowerCase()] : []))
    .join(" ")
}

function normalizeTagKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[./_]+/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]+/g, " ")
    .replace(/[\s-]+/g, "-")
    .replace(/^-|-$/g, "")
}
