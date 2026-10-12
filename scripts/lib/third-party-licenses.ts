// Ported from T3 Code v0.0.45 scripts/lib/third-party-licenses.ts (MIT).
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { Plugin, Rolldown } from "vite";

import type {
  ThirdPartyLicenseEntry,
  ThirdPartyLicenseManifest,
} from "../../src/settings/thirdPartyLicenses";

export const THIRD_PARTY_LICENSES_FILE_NAME = "third-party-licenses.json";
// SPDX License List v3.28.0 texts (license-list-data c4a7237e), checked in so builds never download.
const SPDX_TEXT_DIRECTORY = "third-party/spdx";

export interface ThirdPartyLicensePackageManifest {
  readonly bundle: string;
  readonly path: string | URL;
}

export interface ThirdPartyLicenseCargoWorkspace {
  readonly bundle: string;
  readonly metadata: CargoMetadata;
}

export interface ThirdPartyLicensesPluginOptions {
  readonly configFile?: string | URL;
  readonly packageManifests: ReadonlyArray<ThirdPartyLicensePackageManifest>;
  readonly bundleName: string;
  readonly cargo: { readonly bundle: string; readonly directory: string | URL };
}

interface GeneratedNoticeConfigEntry {
  readonly copyrights?: ReadonlyArray<string>;
  readonly licenseId: string;
  readonly preamble?: ReadonlyArray<string>;
}

interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly homepage?: unknown;
  readonly license?: unknown;
  readonly licenses?: unknown;
  readonly name?: unknown;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly repository?: unknown;
  readonly version?: unknown;
}

interface CustomNoticeConfigEntry {
  readonly bundles?: ReadonlyArray<string>;
  readonly includeInBundles?: ReadonlyArray<string>;
  readonly license: string;
  readonly name: string;
  readonly generatedNotices?: ReadonlyArray<GeneratedNoticeConfigEntry>;
  readonly noticeFiles?: ReadonlyArray<string>;
  readonly sourceUrl?: string;
  readonly version?: string;
}

interface PackageNoticeOverrideConfigEntry {
  readonly generatedNotices?: ReadonlyArray<GeneratedNoticeConfigEntry>;
  readonly license?: string;
  readonly name?: string;
  readonly noticeFile?: string;
  readonly repositoryUrl?: string;
  readonly sourceUrl?: string;
  readonly version?: string;
}

interface ThirdPartyLicensesConfig {
  readonly customNotices: ReadonlyArray<CustomNoticeConfigEntry>;
  readonly packageOverrides: ReadonlyArray<PackageNoticeOverrideConfigEntry>;
}

interface CollectedPackage {
  readonly bundles: Set<string>;
  readonly packageJson: PackageJson;
  readonly packageRoot: string;
  readonly sourceUrl: string | null;
}

interface PackageCollection {
  readonly byIdentity: Map<string, CollectedPackage>;
}

interface CargoDependency {
  readonly pkg: string;
  readonly dep_kinds: ReadonlyArray<{ readonly kind: string | null }>;
}

interface CargoPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  readonly repository: string | null;
  readonly homepage: string | null;
  readonly manifest_path: string;
}

export interface CargoMetadata {
  readonly packages: ReadonlyArray<CargoPackage>;
  readonly resolve: {
    readonly nodes: ReadonlyArray<{
      readonly id: string;
      readonly deps: ReadonlyArray<CargoDependency>;
    }>;
  };
  readonly workspace_members: ReadonlyArray<string>;
}

const EMPTY_CONFIG: ThirdPartyLicensesConfig = {
  customNotices: [],
  packageOverrides: [],
};

const NOTICE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;
const NOTICE_TEXT_EXTENSIONS = new Set([
  "",
  ".0bsd",
  ".agpl",
  ".apache2",
  ".bsd",
  ".gpl",
  ".isc",
  ".lgpl",
  ".markdown",
  ".md",
  ".mit",
  ".mpl",
  ".mpl2",
  ".rst",
  ".txt",
  ".unlicense",
]);

function isNoticeTextFile(fileName: string): boolean {
  return (
    NOTICE_FILE_PATTERN.test(fileName) &&
    NOTICE_TEXT_EXTENSIONS.has(NodePath.extname(fileName).toLowerCase())
  );
}

function asPath(value: string | URL): string {
  return value instanceof URL
    ? NodeURL.fileURLToPath(value)
    : NodePath.resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function httpUrlOrNull(value: string | null): string | null {
  if (value === null) return null;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`${context} must define a non-empty "${key}" string.`);
  }
  return field.trim();
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(
      `${context} must define "${key}" as a non-empty string when present.`,
    );
  }
  return field.trim();
}

function readOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
  context: string,
): ReadonlyArray<string> | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (
    !Array.isArray(field) ||
    field.length === 0 ||
    field.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0,
    )
  ) {
    throw new Error(
      `${context} must define "${key}" as a non-empty string array.`,
    );
  }
  return field.map((entry) => (entry as string).trim());
}

function decodeGeneratedNotice(
  value: unknown,
  context: string,
): GeneratedNoticeConfigEntry {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  const copyrights = readOptionalStringArray(value, "copyrights", context);
  const preamble = readOptionalStringArray(value, "preamble", context);
  return {
    licenseId: readRequiredString(value, "licenseId", context),
    ...(copyrights !== undefined ? { copyrights } : {}),
    ...(preamble !== undefined ? { preamble } : {}),
  };
}

function decodeGeneratedNotices(
  value: unknown,
  context: string,
): ReadonlyArray<GeneratedNoticeConfigEntry> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `${context} must define "generatedNotices" as a non-empty array.`,
    );
  }
  return value.map((entry, index) =>
    decodeGeneratedNotice(
      entry,
      `${context} generated notice at index ${String(index)}`,
    ),
  );
}

function decodeCustomNotices(
  value: unknown,
): ReadonlyArray<CustomNoticeConfigEntry> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      'Third-party license config field "customNotices" must be an array.',
    );
  }
  return value.map((entry, index) => {
    const context = `Third-party custom notice at index ${String(index)}`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
    const version = readOptionalString(entry, "version", context);
    const sourceUrl = readOptionalString(entry, "sourceUrl", context);
    const bundles = readOptionalStringArray(entry, "bundles", context);
    const includeInBundles = readOptionalStringArray(
      entry,
      "includeInBundles",
      context,
    );
    const noticeFile = readOptionalString(entry, "noticeFile", context);
    const noticeFiles = readOptionalStringArray(entry, "noticeFiles", context);
    const generatedNotices = decodeGeneratedNotices(
      entry.generatedNotices,
      context,
    );
    const noticeSourceCount =
      Number(noticeFile !== undefined) +
      Number(noticeFiles !== undefined) +
      Number(generatedNotices !== undefined);
    if (noticeSourceCount !== 1) {
      throw new Error(
        `${context} must define exactly one of "noticeFile", "noticeFiles", or "generatedNotices".`,
      );
    }
    return {
      name: readRequiredString(entry, "name", context),
      license: readRequiredString(entry, "license", context),
      ...(noticeFile !== undefined ? { noticeFiles: [noticeFile] } : {}),
      ...(noticeFiles !== undefined ? { noticeFiles } : {}),
      ...(generatedNotices !== undefined ? { generatedNotices } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
      ...(bundles !== undefined ? { bundles } : {}),
      ...(includeInBundles !== undefined ? { includeInBundles } : {}),
    };
  });
}

function decodePackageOverrides(
  value: unknown,
): ReadonlyArray<PackageNoticeOverrideConfigEntry> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      'Third-party license config field "packageOverrides" must be an array.',
    );
  }
  return value.map((entry, index) => {
    const context = `Third-party package override at index ${String(index)}`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
    const name = readOptionalString(entry, "name", context);
    const repositoryUrl = readOptionalString(entry, "repositoryUrl", context);
    if ((name === undefined) === (repositoryUrl === undefined)) {
      throw new Error(
        `${context} must define exactly one of "name" or "repositoryUrl".`,
      );
    }
    const version = readOptionalString(entry, "version", context);
    const license = readOptionalString(entry, "license", context);
    const noticeFile = readOptionalString(entry, "noticeFile", context);
    const generatedNotice =
      entry.generatedNotice === undefined
        ? undefined
        : decodeGeneratedNotice(
            entry.generatedNotice,
            `${context} generated notice`,
          );
    const generatedNotices = decodeGeneratedNotices(
      entry.generatedNotices,
      context,
    );
    if (
      Number(noticeFile !== undefined) +
        Number(generatedNotice !== undefined) +
        Number(generatedNotices !== undefined) >
      1
    ) {
      throw new Error(
        `${context} can define only one of "noticeFile", "generatedNotice", or "generatedNotices".`,
      );
    }
    const sourceUrl = readOptionalString(entry, "sourceUrl", context);
    return {
      ...(name !== undefined ? { name } : {}),
      ...(repositoryUrl !== undefined ? { repositoryUrl } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(license !== undefined ? { license } : {}),
      ...(noticeFile !== undefined ? { noticeFile } : {}),
      ...(generatedNotice !== undefined
        ? { generatedNotices: [generatedNotice] }
        : {}),
      ...(generatedNotices !== undefined ? { generatedNotices } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    };
  });
}

async function readConfig(configFile: string | URL | undefined): Promise<{
  readonly config: ThirdPartyLicensesConfig;
  readonly directory: string;
}> {
  if (configFile === undefined) {
    return { config: EMPTY_CONFIG, directory: NodePath.resolve(".") };
  }
  const configPath = asPath(configFile);
  const source = await NodeFSP.readFile(configPath, "utf8");
  const decoded = JSON.parse(source) as unknown;
  if (!isRecord(decoded))
    throw new Error("Third-party license config must contain an object.");
  return {
    config: {
      customNotices: decodeCustomNotices(decoded.customNotices),
      packageOverrides: decodePackageOverrides(decoded.packageOverrides),
    },
    directory: NodePath.dirname(configPath),
  };
}

async function readSpdxLicenseText(
  configDirectory: string,
  licenseId: string,
): Promise<string> {
  const path = NodePath.join(
    configDirectory,
    SPDX_TEXT_DIRECTORY,
    `${licenseId}.txt`,
  );
  try {
    const text = (await NodeFSP.readFile(path, "utf8")).trim();
    if (text.length > 0) return text;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  throw new Error(
    `SPDX license text ${licenseId} is missing. Add ${SPDX_TEXT_DIRECTORY}/${licenseId}.txt from the SPDX License List.`,
  );
}

function renderGeneratedNotice(
  config: GeneratedNoticeConfigEntry,
  licenseText: string,
): string {
  const copyrights = config.copyrights ?? [];
  let renderedLicense = licenseText;
  if (copyrights.length > 0) {
    const placeholderPattern =
      /^Copyright[^\n]*(?:<year>|<copyright holders>|<owner>)[^\n]*$/m;
    if (placeholderPattern.test(renderedLicense)) {
      renderedLicense = renderedLicense.replace(
        placeholderPattern,
        copyrights.join("\n"),
      );
    } else if (config.licenseId === "ISC") {
      renderedLicense = renderedLicense.replace(
        /^(?:Copyright[^\n]*\n)+/m,
        `${copyrights.join("\n")}\n`,
      );
    } else {
      renderedLicense = `${copyrights.join("\n")}\n\n${renderedLicense}`;
    }
  }
  return [...(config.preamble ?? []), renderedLicense].join("\n\n").trim();
}

async function generatedNoticeText(
  configs: ReadonlyArray<GeneratedNoticeConfigEntry>,
  configDirectory: string,
): Promise<string> {
  const sections = await Promise.all(
    configs.map(async (config) =>
      renderGeneratedNotice(
        config,
        await readSpdxLicenseText(configDirectory, config.licenseId),
      ),
    ),
  );
  return sections.join("\n\n---\n\n");
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
  const source = await NodeFSP.readFile(packageJsonPath, "utf8");
  const value = JSON.parse(source) as unknown;
  if (!isRecord(value))
    throw new Error(`Package manifest is not an object: ${packageJsonPath}`);
  return value as PackageJson;
}

function packageIdentity(
  packageJson: PackageJson,
  packageRoot: string,
): string {
  const name =
    typeof packageJson.name === "string"
      ? packageJson.name
      : NodePath.basename(packageRoot);
  const version =
    typeof packageJson.version === "string" ? packageJson.version : "unknown";
  return `${name}@${version}`;
}

function addNpmPackage(
  collection: PackageCollection,
  found: { readonly packageJson: PackageJson; readonly packageRoot: string },
  bundle: string,
): void {
  const identity = packageIdentity(found.packageJson, found.packageRoot);
  const existing = collection.byIdentity.get(identity);
  if (existing) {
    existing.bundles.add(bundle);
    return;
  }
  collection.byIdentity.set(identity, {
    bundles: new Set([bundle]),
    packageJson: found.packageJson,
    packageRoot: found.packageRoot,
    sourceUrl: httpUrlOrNull(packageSourceUrl(found.packageJson)),
  });
}

async function findPackageRoot(
  resolvedPath: string,
  expectedName?: string,
): Promise<{
  readonly packageJson: PackageJson;
  readonly packageRoot: string;
} | null> {
  let current = NodePath.dirname(resolvedPath);
  const root = NodePath.parse(current).root;

  while (current !== root) {
    const packageJsonPath = NodePath.join(current, "package.json");
    try {
      const packageJson = await readPackageJson(packageJsonPath);
      const matchesExpectedPackage =
        expectedName !== undefined
          ? packageJson.name === expectedName
          : typeof packageJson.name === "string" &&
            typeof packageJson.version === "string";
      if (matchesExpectedPackage) {
        return { packageJson, packageRoot: await NodeFSP.realpath(current) };
      }
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    current = NodePath.dirname(current);
  }
  return null;
}

async function resolveDependencyPackage(
  dependencyName: string,
  fromPackageJsonPath: string,
): Promise<{
  readonly packageJson: PackageJson;
  readonly packageRoot: string;
} | null> {
  const requireFromPackage = NodeModule.createRequire(fromPackageJsonPath);
  const candidates = [`${dependencyName}/package.json`, dependencyName];
  for (const candidate of candidates) {
    try {
      const resolved = requireFromPackage.resolve(candidate);
      const found = await findPackageRoot(resolved, dependencyName);
      if (found) return found;
    } catch (error) {
      const code = errorCode(error);
      if (
        code !== "MODULE_NOT_FOUND" &&
        code !== "ERR_PACKAGE_PATH_NOT_EXPORTED"
      )
        throw error;
    }
  }

  let current = NodePath.dirname(fromPackageJsonPath);
  const root = NodePath.parse(current).root;
  while (true) {
    const packageRoot = NodePath.join(current, "node_modules", dependencyName);
    try {
      const packageJson = await readPackageJson(
        NodePath.join(packageRoot, "package.json"),
      );
      if (packageJson.name === dependencyName) {
        return {
          packageJson,
          packageRoot: await NodeFSP.realpath(packageRoot),
        };
      }
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    if (current === root) break;
    current = NodePath.dirname(current);
  }
  return null;
}

function dependencyNames(packageJson: PackageJson): ReadonlyArray<string> {
  return [
    ...new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

async function collectProductionDependencyPackages(
  collection: PackageCollection,
  packageManifests: ReadonlyArray<ThirdPartyLicensePackageManifest>,
): Promise<void> {
  const visited = new Set<string>();

  const visitManifest = async (
    packageJsonPath: string,
    bundle: string,
  ): Promise<void> => {
    const packageJson = await readPackageJson(packageJsonPath);
    for (const dependencyName of dependencyNames(packageJson)) {
      const resolved = await resolveDependencyPackage(
        dependencyName,
        packageJsonPath,
      );
      if (!resolved) continue;
      const visitKey = `${bundle}:${resolved.packageRoot}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      addNpmPackage(collection, resolved, bundle);
      await visitManifest(
        NodePath.join(resolved.packageRoot, "package.json"),
        bundle,
      );
    }
  };

  for (const manifest of packageManifests) {
    await visitManifest(asPath(manifest.path), manifest.bundle);
  }
}

function moduleFilePath(moduleId: string): string | null {
  if (moduleId.includes("\0")) return null;
  const withoutQuery = moduleId.split(/[?#]/, 1)[0] ?? moduleId;
  const viteFilePath = withoutQuery.startsWith("/@fs/")
    ? withoutQuery.slice("/@fs/".length)
    : withoutQuery;
  const filePath = withoutQuery.startsWith("file:")
    ? NodeURL.fileURLToPath(withoutQuery)
    : /^[A-Za-z]:[\\/]/.test(viteFilePath)
      ? viteFilePath
      : NodePath.resolve("/", viteFilePath);
  const normalized = filePath.replaceAll("\\", "/");
  return normalized.includes("/node_modules/") ? filePath : null;
}

async function addBundledModulePackages(
  collection: PackageCollection,
  moduleIds: ReadonlyArray<string>,
  bundle: string,
): Promise<void> {
  for (const moduleId of moduleIds) {
    const filePath = moduleFilePath(moduleId);
    if (!filePath) continue;
    let found: Awaited<ReturnType<typeof findPackageRoot>>;
    try {
      found = await findPackageRoot(await NodeFSP.realpath(filePath));
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    if (!found || typeof found.packageJson.name !== "string") continue;
    addNpmPackage(collection, found, bundle);
  }
}

function decodeCargoMetadata(value: unknown): CargoMetadata {
  const valid =
    isRecord(value) &&
    Array.isArray(value.packages) &&
    Array.isArray(value.workspace_members) &&
    isRecord(value.resolve) &&
    Array.isArray(value.resolve.nodes);
  if (!valid) throw new Error("cargo metadata returned an unexpected shape.");
  return value as unknown as CargoMetadata;
}

export async function readCargoMetadata(
  directory: string,
): Promise<CargoMetadata> {
  const run = (args: ReadonlyArray<string>) =>
    new Promise<string>((resolve, reject) => {
      NodeChildProcess.execFile(
        args[0]!,
        args.slice(1),
        { cwd: directory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) =>
          error
            ? reject(
                new Error(
                  `${args.join(" ")} failed: ${stderr || error.message}`,
                ),
              )
            : resolve(stdout),
      );
    });
  const target =
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    /^host: (\S+)$/m.exec(await run(["rustc", "-vV"]))?.[1];
  if (!target) throw new Error("rustc -vV did not report a host target.");
  const stdout = await run([
    "cargo",
    "metadata",
    "--format-version",
    "1",
    "--locked",
    "--filter-platform",
    target,
  ]);
  return decodeCargoMetadata(JSON.parse(stdout) as unknown);
}

function collectCargoPackages(
  collection: PackageCollection,
  cargo: ThirdPartyLicenseCargoWorkspace,
): void {
  const { metadata, bundle } = cargo;
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const members = new Set(metadata.workspace_members);
  const linked = new Set(members);
  const pending = [...members];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const dependency of nodes.get(id)?.deps ?? []) {
      if (linked.has(dependency.pkg)) continue;
      if (!dependency.dep_kinds.some((kind) => kind.kind === null)) continue;
      linked.add(dependency.pkg);
      pending.push(dependency.pkg);
    }
  }
  for (const id of linked) {
    if (members.has(id)) continue;
    const pkg = packages.get(id);
    if (!pkg) throw new Error(`cargo metadata has no package for ${id}.`);
    collection.byIdentity.set(`cargo:${pkg.name}@${pkg.version}`, {
      bundles: new Set([bundle]),
      packageJson: {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        repository: pkg.repository,
      },
      packageRoot: NodePath.dirname(pkg.manifest_path),
      sourceUrl: httpUrlOrNull(
        normalizeRepositoryUrl(pkg.repository) ?? pkg.homepage,
      ),
    });
  }
}

function normalizeLicense(packageJson: PackageJson): string | null {
  if (
    typeof packageJson.license === "string" &&
    packageJson.license.trim().length > 0
  ) {
    return packageJson.license.trim();
  }
  if (
    isRecord(packageJson.license) &&
    typeof packageJson.license.type === "string"
  ) {
    return packageJson.license.type.trim() || null;
  }
  const declaredLicenses = Array.isArray(packageJson.license)
    ? packageJson.license
    : packageJson.licenses;
  if (Array.isArray(declaredLicenses)) {
    const licenses = declaredLicenses
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (isRecord(entry) && typeof entry.type === "string")
          return entry.type.trim();
        return "";
      })
      .filter((entry) => entry.length > 0);
    if (licenses.length > 0) return licenses.join(" OR ");
  }
  return null;
}

function normalizeRepositoryUrl(value: unknown): string | null {
  const raw =
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.url === "string"
        ? value.url
        : null;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("github:"))
    return `https://github.com/${trimmed.slice(7)}`;
  const normalized = trimmed
    .replace(/^git\+ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/(?:git@)?github\.com\//, "https://github.com/")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/#.*$/, "")
    .replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(normalized))
    return `https://github.com/${normalized}`;
  return normalized;
}

function packageSourceUrl(packageJson: PackageJson): string | null {
  if (
    typeof packageJson.homepage === "string" &&
    packageJson.homepage.trim().length > 0
  ) {
    return packageJson.homepage.trim();
  }
  return normalizeRepositoryUrl(packageJson.repository);
}

async function readPackageNoticeText(
  packageRoot: string,
): Promise<string | null> {
  const noticeFiles: string[] = [];
  const rootEntries = await NodeFSP.readdir(packageRoot, {
    withFileTypes: true,
  });
  noticeFiles.push(
    ...rootEntries
      .filter((entry) => entry.isFile() && isNoticeTextFile(entry.name))
      .map((entry) => entry.name),
  );

  const collectNestedNoticeFiles = async (
    directory: string,
    depth: number,
  ): Promise<void> => {
    const directoryEntries = await NodeFSP.readdir(
      NodePath.join(packageRoot, directory),
      { withFileTypes: true },
    );
    await Promise.all(
      directoryEntries.map(async (entry) => {
        const relativePath = NodePath.join(directory, entry.name);
        if (entry.isFile() && isNoticeTextFile(entry.name)) {
          noticeFiles.push(relativePath);
          return;
        }
        if (
          depth > 0 &&
          entry.isDirectory() &&
          entry.name !== "node_modules" &&
          entry.name !== ".git"
        ) {
          await collectNestedNoticeFiles(relativePath, depth - 1);
        }
      }),
    );
  };
  await Promise.all(
    rootEntries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== "node_modules" &&
          entry.name !== ".git",
      )
      .map((entry) => collectNestedNoticeFiles(entry.name, 2)),
  );
  noticeFiles.sort((left, right) => left.localeCompare(right));
  if (noticeFiles.length === 0) return null;

  const sections: string[] = [];
  for (const fileName of noticeFiles) {
    const contents = (
      await NodeFSP.readFile(NodePath.join(packageRoot, fileName), "utf8")
    ).trim();
    if (contents.length === 0) continue;
    sections.push(
      noticeFiles.length === 1 ? contents : `${fileName}\n\n${contents}`,
    );
  }
  return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
}

function repositoryNoticeKey(
  packageJson: PackageJson,
  license: string,
): string | null {
  const repositoryUrl = normalizeRepositoryUrl(packageJson.repository);
  return repositoryUrl
    ? `${repositoryUrl.toLowerCase()}\n${license.toLowerCase()}`
    : null;
}

async function collectRepositoryNotices(
  collection: PackageCollection,
  packageNotices: Map<string, Promise<string | null>>,
): Promise<ReadonlyMap<string, string>> {
  const notices = new Map<string, string>();
  const candidates = await Promise.all(
    [...collection.byIdentity.values()].map(async (collected) => {
      const license = normalizeLicense(collected.packageJson);
      if (!license) return null;
      const key = repositoryNoticeKey(collected.packageJson, license);
      if (!key) return null;
      const noticeText = await packageNoticeText(
        collected.packageRoot,
        packageNotices,
      );
      return noticeText ? { key, noticeText } : null;
    }),
  );
  for (const candidate of candidates) {
    if (candidate && !notices.has(candidate.key))
      notices.set(candidate.key, candidate.noticeText);
  }
  return notices;
}

function packageNoticeText(
  packageRoot: string,
  cache: Map<string, Promise<string | null>>,
): Promise<string | null> {
  const existing = cache.get(packageRoot);
  if (existing) return existing;
  const notice = readPackageNoticeText(packageRoot);
  cache.set(packageRoot, notice);
  return notice;
}

function findPackageOverride(
  overrides: ReadonlyArray<PackageNoticeOverrideConfigEntry>,
  name: string,
  version: string,
  packageJson: PackageJson,
): PackageNoticeOverrideConfigEntry | undefined {
  const repositoryUrl = normalizeRepositoryUrl(
    packageJson.repository,
  )?.toLowerCase();
  const matchesRepository = (override: PackageNoticeOverrideConfigEntry) =>
    repositoryUrl !== undefined &&
    override.repositoryUrl !== undefined &&
    normalizeRepositoryUrl(override.repositoryUrl)?.toLowerCase() ===
      repositoryUrl;
  return (
    overrides.find(
      (override) => override.name === name && override.version === version,
    ) ??
    overrides.find(
      (override) => override.name === name && override.version === undefined,
    ) ??
    overrides.find(
      (override) => matchesRepository(override) && override.version === version,
    ) ??
    overrides.find(
      (override) =>
        matchesRepository(override) && override.version === undefined,
    )
  );
}

async function packageEntry(
  collected: CollectedPackage,
  config: ThirdPartyLicensesConfig,
  configDirectory: string,
  packageNotices: Map<string, Promise<string | null>>,
  repositoryNotices: ReadonlyMap<string, string>,
): Promise<ThirdPartyLicenseEntry> {
  const name =
    typeof collected.packageJson.name === "string"
      ? collected.packageJson.name
      : NodePath.basename(collected.packageRoot);
  const version =
    typeof collected.packageJson.version === "string"
      ? collected.packageJson.version
      : "unknown";
  const override = findPackageOverride(
    config.packageOverrides,
    name,
    version,
    collected.packageJson,
  );
  const license = override?.license ?? normalizeLicense(collected.packageJson);
  if (!license || /^(?:unlicensed|proprietary)$/i.test(license)) {
    throw new Error(
      `${name}@${version} does not declare a distributable license. Add a package override in the third-party license config if the package publishes its notice elsewhere.`,
    );
  }

  const repositoryKey = repositoryNoticeKey(collected.packageJson, license);
  const noticeText = override?.generatedNotices
    ? await generatedNoticeText(override.generatedNotices, configDirectory)
    : override?.noticeFile
      ? (
          await NodeFSP.readFile(
            NodePath.resolve(configDirectory, override.noticeFile),
            "utf8",
          )
        ).trim()
      : ((await packageNoticeText(collected.packageRoot, packageNotices)) ??
        (repositoryKey ? repositoryNotices.get(repositoryKey) : undefined));
  if (!noticeText) {
    throw new Error(
      `${name}@${version} does not include a license or notice file. Add a package override with "noticeFile" or "generatedNotice" in the third-party license config.`,
    );
  }

  return {
    bundles: [...collected.bundles].sort((left, right) =>
      left.localeCompare(right),
    ),
    kind: "package",
    license,
    name,
    noticeText,
    sourceUrl: override?.sourceUrl ?? collected.sourceUrl,
    version,
  };
}

async function customEntries(
  config: ThirdPartyLicensesConfig,
  configDirectory: string,
  includedBundles: ReadonlySet<string>,
): Promise<ReadonlyArray<ThirdPartyLicenseEntry>> {
  return Promise.all(
    config.customNotices
      .filter(
        (notice) =>
          (notice.includeInBundles ?? notice.bundles) === undefined ||
          (notice.includeInBundles ?? notice.bundles)?.some((bundle) =>
            includedBundles.has(bundle),
          ),
      )
      .map(async (notice) => {
        const noticeText = notice.generatedNotices
          ? await generatedNoticeText(notice.generatedNotices, configDirectory)
          : (
              await Promise.all(
                notice.noticeFiles!.map(async (noticeFile) => {
                  const contents = (
                    await NodeFSP.readFile(
                      NodePath.resolve(configDirectory, noticeFile),
                      "utf8",
                    )
                  ).trim();
                  if (contents.length === 0) {
                    throw new Error(
                      `Custom third-party notice "${notice.name}" is empty.`,
                    );
                  }
                  return contents;
                }),
              )
            ).join("\n\n---\n\n");
        if (noticeText.length === 0) {
          throw new Error(
            `Custom third-party notice "${notice.name}" is empty.`,
          );
        }
        return {
          bundles: [...(notice.bundles ?? ["assets"])].sort((left, right) =>
            left.localeCompare(right),
          ),
          kind: "custom" as const,
          license: notice.license,
          name: notice.name,
          noticeText,
          sourceUrl: notice.sourceUrl ?? null,
          version: notice.version ?? null,
        };
      }),
  );
}

function entrySort(
  left: ThirdPartyLicenseEntry,
  right: ThirdPartyLicenseEntry,
): number {
  return (
    left.name.localeCompare(right.name) ||
    (left.version ?? "").localeCompare(right.version ?? "") ||
    left.kind.localeCompare(right.kind)
  );
}

function assertUniqueEntries(
  entries: ReadonlyArray<ThirdPartyLicenseEntry>,
): void {
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = JSON.stringify([entry.kind, entry.name, entry.version]);
    if (identities.has(identity)) {
      throw new Error(
        `Third-party license generation found a duplicate ${entry.kind} notice for ${entry.name}${entry.version ? `@${entry.version}` : ""}.`,
      );
    }
    identities.add(identity);
  }
}

export async function generateThirdPartyLicenseManifest(input: {
  readonly configFile?: string | URL;
  readonly packageManifests: ReadonlyArray<ThirdPartyLicensePackageManifest>;
  readonly cargo?: ThirdPartyLicenseCargoWorkspace;
  readonly bundledModuleIds?: ReadonlyArray<string>;
  readonly bundleName?: string;
}): Promise<ThirdPartyLicenseManifest> {
  const collection: PackageCollection = { byIdentity: new Map() };
  const [{ config, directory }] = await Promise.all([
    readConfig(input.configFile),
    collectProductionDependencyPackages(collection, input.packageManifests),
  ]);
  if (input.bundledModuleIds && input.bundleName) {
    await addBundledModulePackages(
      collection,
      input.bundledModuleIds,
      input.bundleName,
    );
  }
  if (input.cargo) collectCargoPackages(collection, input.cargo);

  const packageNotices = new Map<string, Promise<string | null>>();
  const repositoryNotices = await collectRepositoryNotices(
    collection,
    packageNotices,
  );

  const packageEntryResults = await Promise.allSettled(
    [...collection.byIdentity.values()].map((collected) =>
      packageEntry(
        collected,
        config,
        directory,
        packageNotices,
        repositoryNotices,
      ),
    ),
  );
  const failures = packageEntryResults.flatMap((result) =>
    result.status === "rejected"
      ? [
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        ]
      : [],
  );
  if (failures.length > 0) {
    throw new Error(
      `Third-party license generation found ${String(failures.length)} invalid package notice${failures.length === 1 ? "" : "s"}:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }
  const packageEntries = packageEntryResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const includedBundles = new Set(
    input.packageManifests.map((manifest) => manifest.bundle),
  );
  if (input.bundleName) includedBundles.add(input.bundleName);
  if (input.cargo) includedBundles.add(input.cargo.bundle);
  const manualEntries = await customEntries(config, directory, includedBundles);
  const entries = [...packageEntries, ...manualEntries].sort(entrySort);
  assertUniqueEntries(entries);
  return {
    schemaVersion: 1,
    entries,
  };
}

function moduleIdsFromBundle(
  bundle: Rolldown.OutputBundle,
): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk") continue;
    for (const id of Object.keys(output.modules)) ids.add(id);
  }
  return [...ids];
}

function serializeManifest(manifest: ThirdPartyLicenseManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

export function thirdPartyLicensesPlugin(
  options: ThirdPartyLicensesPluginOptions,
): Plugin {
  const generate = async (bundledModuleIds?: ReadonlyArray<string>) =>
    generateThirdPartyLicenseManifest({
      packageManifests: options.packageManifests,
      bundleName: options.bundleName,
      cargo: {
        bundle: options.cargo.bundle,
        metadata: await readCargoMetadata(asPath(options.cargo.directory)),
      },
      ...(bundledModuleIds !== undefined ? { bundledModuleIds } : {}),
      ...(options.configFile !== undefined
        ? { configFile: options.configFile }
        : {}),
    });
  return {
    name: "bot-code:third-party-licenses",
    configureServer(server) {
      let manifestPromise: Promise<ThirdPartyLicenseManifest> | null = null;
      server.middlewares.use((request, response, next) => {
        if (
          request.originalUrl?.split("?", 1)[0] !==
          `/${THIRD_PARTY_LICENSES_FILE_NAME}`
        ) {
          next();
          return;
        }
        manifestPromise ??= generate().catch((error: unknown) => {
          manifestPromise = null;
          throw error;
        });
        void manifestPromise.then(
          (manifest) => {
            response.statusCode = 200;
            response.setHeader(
              "Content-Type",
              "application/json; charset=utf-8",
            );
            response.setHeader("Cache-Control", "no-store");
            response.end(serializeManifest(manifest));
          },
          (error: unknown) => {
            next(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    },
    async generateBundle(_outputOptions, bundle) {
      const manifest = await generate(moduleIdsFromBundle(bundle));
      this.emitFile({
        type: "asset",
        fileName: THIRD_PARTY_LICENSES_FILE_NAME,
        source: serializeManifest(manifest),
      });
    },
  };
}
