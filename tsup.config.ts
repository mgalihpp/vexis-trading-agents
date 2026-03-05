import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/main.ts", "src/scripts/validate.ts", "src/scripts/ops-tail.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  target: "es2022"
});
