import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/** Where `tidybot ui` listens in development (`TIDYBOT_UI_TOKEN=dev pnpm dev ui --no-open --port 4477`). */
const api = process.env.TIDYBOT_UI_API ?? "http://127.0.0.1:4477";

export default defineConfig({
  plugins: [solid()],
  resolve: { alias: { "@contract": fileURLToPath(new URL("../src/ui/contract.ts", import.meta.url)) } },
  // Served by the tidybot package from dist/web.
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    // The UI server only accepts its own host and origin, so the proxy speaks as that page.
    proxy: { "/api": { target: api, changeOrigin: true, headers: { origin: api } } },
  },
});
