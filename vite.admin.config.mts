import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/admin/",
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/portal", import.meta.url)),
    },
  },
  build: {
    outDir: "public/admin",
    emptyOutDir: false,
    rollupOptions: {
      input: {
        admin: fileURLToPath(new URL("./admin.html", import.meta.url)),
        login: fileURLToPath(new URL("./admin-login.html", import.meta.url)),
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000",
      "/admin/api": "http://localhost:3000",
    },
  },
});
