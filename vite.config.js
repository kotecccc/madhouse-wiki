import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Keep the dev URL stable so the browser's HMR WebSocket uses this origin.
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
  },
  // Preview serves the built output and intentionally has no HMR.
  preview: {
    host: "127.0.0.1",
    port: 4175,
    strictPort: true,
  },
});
