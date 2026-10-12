declare module "node:fs/promises" {
  interface Dirent {
    readonly name: string;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<Dirent[]>;
  export function realpath(path: string): Promise<string>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<unknown>;
  export function writeFile(
    path: string,
    data: string,
    encoding: "utf8",
  ): Promise<void>;
  export function rm(
    path: string,
    options?: { force?: boolean; recursive?: boolean },
  ): Promise<void>;
}

declare module "node:path" {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function join(...paths: string[]): string;
  export function parse(path: string): { root: string };
  export function resolve(...paths: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:module" {
  export function createRequire(path: string): {
    resolve(request: string): string;
  };
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:child_process" {
  export function execFile(
    file: string,
    args: ReadonlyArray<string>,
    options: { cwd?: string; encoding: "utf8"; maxBuffer?: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): unknown;
}
