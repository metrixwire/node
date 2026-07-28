import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // Declarations are emitted separately via `tsc` (see build script) to avoid a
  // rollup-plugin-dts/TypeScript version mismatch in this toolchain.
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node18',
  // Optional integrations are resolved at runtime from the host app.
  external: ['pg', 'mysql2', '@prisma/client'],
})
