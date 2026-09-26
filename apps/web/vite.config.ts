import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_DEV_PROXY_TARGET || "http://localhost:8080";

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        // The Parse SDK's LiveQuery pulls in Node's "events", which Vite
        // externalizes in the browser; point it at the npm polyfill.
        events: fileURLToPath(new URL("./node_modules/events/events.js", import.meta.url))
      }
    },
    server: {
      port: Number(env.PORT) || 3001,
      // In dev, /api/app/* is proxied to the Parse server so the app can run
      // without VITE_SERVERURL set (same-origin, like production behind Caddy).
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, "")
        }
      }
    },
    build: {
      outDir: "dist",
      sourcemap: env.GENERATE_SOURCEMAP === "true"
    }
  };
});
