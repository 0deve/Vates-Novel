import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// During `tauri android dev`, the CLI sets TAURI_DEV_HOST to the machine's
// LAN IP and the app on the device loads the frontend from it — Vite must
// listen on that address (it binds localhost-only by default).
const host = process.env.TAURI_DEV_HOST;

// Tauri expects a fixed dev port; don't let Vite fall back to another one.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Don't let the Rust build churn retrigger Vite.
      ignored: ["**/src-tauri/**"],
    },
  },
});
