import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Vendored third-party components: AI Elements and shadcn/ui are copied
    // into the repo by their installers rather than pulled from a package.
    // They're dependencies that happen to live in src/, governed by their
    // upstream rules — excluded so their warnings don't drown ours. Code we
    // actually wrote stays fully linted.
    "src/components/ai-elements/**",
    "src/components/ui/**",
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
