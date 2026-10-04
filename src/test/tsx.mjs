import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL) {
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
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
      },
      fileName: fileURLToPath(url),
    }).outputText;
    return { format: "module", source, shortCircuit: true };
  },
});
