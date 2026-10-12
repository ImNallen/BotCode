import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { thirdPartyLicensesPlugin } from "./scripts/lib/third-party-licenses";
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    thirdPartyLicensesPlugin({
      bundleName: "web",
      packageManifests: [
        { bundle: "web", path: new URL("./package.json", import.meta.url) },
      ],
      cargo: { bundle: "desktop", directory: new URL("./", import.meta.url) },
      configFile: new URL(
        "./third-party-licenses.config.json",
        import.meta.url,
      ),
    }),
  ],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  build: { target: "es2022" },
});
