import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "lucide-react/dynamic")
      return nextResolve("lucide-react/dynamic.mjs", context);
    if (
      specifier.startsWith(".") &&
      !specifier.includes("?") &&
      context.parentURL
    ) {
      const url = new URL(specifier, context.parentURL);
      for (const extension of [".ts", ".tsx"]) {
        const candidate = new URL(`${url.href}${extension}`);
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(candidate.href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    // Vite asset URL imports (the terminal's font and WASM files).
    if (/\?url(&|$)/.test(url))
      return {
        format: "module",
        source: `export default ${JSON.stringify(url)};`,
        shortCircuit: true,
      };
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        // TypeScript defaults to ES5, where for...of over a Set or Map iterates nothing.
        target: ts.ScriptTarget.ES2022,
      },
      fileName: fileURLToPath(url),
    }).outputText;
    return { format: "module", source, shortCircuit: true };
  },
});
