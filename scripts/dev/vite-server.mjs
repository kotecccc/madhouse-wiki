// Docker Desktop bind mounts need polling; HMR stays on the published HTTP port.
export function devServerOptions(port, env = process.env) {
  const docker = env.MADHOUSE_DOCKER_DEV === "1";
  return {
    host: docker ? "0.0.0.0" : "127.0.0.1",
    port,
    strictPort: true,
    watch: {
      usePolling: docker || env.CHOKIDAR_USEPOLLING === "true",
      interval: 500,
      ignored: ["**/research/**", "**/artifacts/**", "**/.sites-release/**"],
    },
    ...(docker
      ? {
          hmr: {
            protocol: "ws",
            host: "127.0.0.1",
            clientPort: port,
            path: "/__vite_hmr",
          },
        }
      : {}),
  };
}

// Vite assumes files inside root are already watched. Docker bind mounts can
// miss directory-add events, so explicitly watch newly loaded source modules.
export function dockerSourceHmrPlugin(env = process.env) {
  let server;
  return {
    name: "docker-source-hmr",
    apply: "serve",
    enforce: "pre",
    configureServer(value) {
      if (env.MADHOUSE_DOCKER_DEV === "1") server = value;
    },
    transform(_code, id) {
      if (!server || id.includes("\0")) return;
      const file = id.split("?")[0];
      if (
        !file.startsWith("/app/") ||
        /\/(?:node_modules|research|artifacts|dist|\.git)\//.test(file)
      )
        return;
      server.watcher.add(file);
    },
  };
}
