import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    rolldownOptions: {
      input: "src/index.html",
    },
  },
  server: {
    port: 4000,
  },
});
