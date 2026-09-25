import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    rolldownOptions: {
      // Absolute, since the build resolves this from the project directory
      // but the dev server's dependency scan resolves it from `root`
      input: fileURLToPath(new URL("./src/index.html", import.meta.url)),
    },
  },
  server: {
    port: 4000,
  },
});
