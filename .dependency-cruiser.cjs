/**
 * Reglas de dependencia entre capas (ver apps/server/src/README.md). `pnpm lint:arch` las comprueba en CI.
 * container.ts y main.ts son la raíz de composición y pueden importar cualquier capa.
 */
const SRC = "^apps/server/src/";
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "shared-es-hoja",
      comment: "shared (config, seguridad, observabilidad) no conoce el resto del proyecto",
      severity: "error",
      from: { path: `${SRC}shared/` },
      to: { path: `${SRC}(access|orchestration|domain|integrations|execution|data|container|main)` },
    },
    {
      name: "dominio-interior",
      comment: "el dominio no depende de HTTP, del runtime ni de adaptadores; define puertos que otros implementan",
      severity: "error",
      from: { path: `${SRC}domain/` },
      to: { path: `${SRC}(access|orchestration|integrations|execution/workers)` },
    },
    {
      name: "integraciones-sin-runtime-ni-http",
      severity: "error",
      from: { path: `${SRC}integrations/` },
      to: { path: `${SRC}(access|orchestration|execution/workers)` },
    },
    {
      name: "orquestacion-sin-http",
      severity: "error",
      from: { path: `${SRC}orchestration/` },
      to: { path: `${SRC}(access|execution/workers)` },
    },
    {
      name: "acceso-no-ejecuta-workers",
      severity: "error",
      from: { path: `${SRC}access/` },
      to: { path: `${SRC}execution/workers` },
    },
    {
      name: "workers-sin-http",
      severity: "error",
      from: { path: `${SRC}execution/` },
      to: { path: `${SRC}access/` },
    },
    {
      name: "http-solo-en-acceso",
      comment: "Fastify y Better Auth solo en la capa de acceso",
      severity: "error",
      from: { path: SRC, pathNot: `${SRC}(access/|container\\.ts|main\\.ts)` },
      to: { path: "node_modules/(fastify|@fastify|fastify-type-provider-zod|fastify-plugin|better-auth)" },
    },
    {
      name: "ai-sdk-solo-en-orquestacion",
      comment: "Los proveedores de IA solo se importan en la capa de orquestación",
      severity: "error",
      from: { path: SRC, pathNot: `${SRC}orchestration/` },
      to: { path: "node_modules/(ai|@ai-sdk)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(generated|dist)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "apps/server/tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default", "types"], extensions: [".ts", ".js"] },
  },
};
