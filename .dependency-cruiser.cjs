module.exports = {
  forbidden: [
    {
      name: "no-unresolved",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    { name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
    {
      name: "shared-is-portable",
      severity: "error",
      from: { path: "^src/shared" },
      to: { path: "^src/(?!shared/)" },
    },
    {
      name: "domain-is-pure",
      severity: "error",
      from: { path: "^src/domain" },
      to: { path: "^src/(?!domain/|shared/)" },
    },
    {
      name: "services-use-ports",
      severity: "error",
      from: { path: "^src/services" },
      to: { path: "^src/(?!services/|domain/|shared/)" },
    },
    {
      name: "adapters-do-not-call-entrypoints",
      severity: "error",
      from: { path: "^src/infrastructure" },
      to: { path: "^src/(server|cli|web)/" },
    },
    {
      name: "web-uses-api-only",
      severity: "error",
      from: { path: "^src/web" },
      to: { path: "^src/(?!web/|shared/|drawing/)" },
    },
    {
      name: "no-node-in-portable-code",
      severity: "error",
      from: { path: "^src/(web|drawing|shared|domain|services)/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "no-react-in-core",
      severity: "error",
      from: { path: "^src/(shared|domain|services|infrastructure)/" },
      to: { path: "node_modules/(react|ink)(/|$)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
    },
  },
};
