import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/portal", import.meta.url)),
    },
  },
  build: {
    outDir: "public/captive-portal",
    emptyOutDir: false,
    rollupOptions: {
      input: {
        portal: fileURLToPath(new URL("./index.html", import.meta.url)),
        success: fileURLToPath(new URL("./success.html", import.meta.url)),
        error: fileURLToPath(new URL("./error.html", import.meta.url)),
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000",
    },
  },
});
