import { readKnowledgeBase } from "./query.mjs";

// SQL is queried for dev/SSR and every production build. No JSON catalogues or
// browser SQL snapshot are generated; Vite packages only the selected public model.
export function cataloguePlugin(root) {
  const id = "virtual:madhouse-catalogue";
  return {
    name: "sqlite-catalogue",
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url?.split("?")[0] === "/") {
          const module = server.moduleGraph.getModuleById("\0" + id);
          if (module) server.moduleGraph.invalidateModule(module);
        }
        next();
      });
    },
    resolveId(source) {
      if (source === id) return "\0" + id;
    },
    load(source) {
      if (source === "\0" + id)
        return `export const knowledgeBase=${JSON.stringify(readKnowledgeBase(root))}; export default knowledgeBase;`;
    },
  };
}
