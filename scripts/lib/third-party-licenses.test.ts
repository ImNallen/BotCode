// Fixture shape ported from T3 Code v0.0.45 scripts/lib/third-party-licenses.test.ts (MIT).
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  generateThirdPartyLicenseManifest,
  type CargoMetadata,
} from "./third-party-licenses";

const REPOSITORY_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const T3_LICENSE = NodePath.join(REPOSITORY_ROOT, "third-party/t3code/LICENSE");
const tempDirectories: string[] = [];

async function writeJson(path: string, value: unknown): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeCrate(root: string, name: string, license: string) {
  const crateRoot = NodePath.join(root, "registry", `${name}-1.0.0`);
  await NodeFSP.mkdir(crateRoot, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(crateRoot, "Cargo.toml"),
    "[package]\n",
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(crateRoot, "LICENSE"),
    `${license}\n`,
    "utf8",
  );
  return crateRoot;
}

function crate(name: string, crateRoot: string) {
  return {
    id: `registry+${name}@1.0.0`,
    name,
    version: "1.0.0",
    license: "MIT",
    repository: `https://github.com/example/${name}`,
    homepage: null,
    manifest_path: NodePath.join(crateRoot, "Cargo.toml"),
  };
}

async function realT3CodeNotice(): Promise<unknown> {
  const config = JSON.parse(
    await NodeFSP.readFile(
      NodePath.join(REPOSITORY_ROOT, "third-party-licenses.config.json"),
      "utf8",
    ),
  ) as { customNotices: { name: string }[] };
  const notice = config.customNotices.find((entry) => entry.name === "T3 Code");
  assert.ok(notice, "the repository config lists T3 Code");
  return { ...notice, noticeFile: T3_LICENSE };
}

async function createFixture() {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "l1code-licenses-"),
  );
  tempDirectories.push(root);
  const appManifest = NodePath.join(root, "package.json");
  const dependencyRoot = NodePath.join(root, "node_modules", "demo-dependency");
  const configFile = NodePath.join(root, "third-party-licenses.config.json");
  await writeJson(appManifest, {
    name: "fixture-app",
    dependencies: { "demo-dependency": "1.2.3" },
    devDependencies: { "dev-tool": "1.0.0" },
  });
  await writeJson(NodePath.join(dependencyRoot, "package.json"), {
    name: "demo-dependency",
    version: "1.2.3",
    license: "MIT",
    main: "index.js",
    repository: "example/demo-dependency",
  });
  await NodeFSP.writeFile(
    NodePath.join(dependencyRoot, "index.js"),
    "export {};\n",
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(dependencyRoot, "LICENSE"),
    "Demo MIT license text\n",
    "utf8",
  );
  const devToolRoot = NodePath.join(root, "node_modules", "dev-tool");
  await writeJson(NodePath.join(devToolRoot, "package.json"), {
    name: "dev-tool",
    version: "1.0.0",
    license: "MIT",
  });
  await NodeFSP.writeFile(
    NodePath.join(devToolRoot, "LICENSE"),
    "Dev tool text\n",
    "utf8",
  );
  const normalRoot = await writeCrate(
    root,
    "normal-crate",
    "Normal crate text",
  );
  const devRoot = await writeCrate(root, "dev-crate", "Dev crate text");
  const buildRoot = await writeCrate(root, "build-crate", "Build crate text");
  const member = "path+file:///app#l1-code@0.1.0";
  const normal = crate("normal-crate", normalRoot);
  const dev = crate("dev-crate", devRoot);
  const build = crate("build-crate", buildRoot);
  const metadata: CargoMetadata = {
    packages: [
      {
        id: member,
        name: "l1-code",
        version: "0.1.0",
        license: null,
        repository: null,
        homepage: null,
        manifest_path: NodePath.join(root, "Cargo.toml"),
      },
      normal,
      dev,
      build,
    ],
    workspace_members: [member],
    resolve: {
      nodes: [
        {
          id: member,
          deps: [
            { pkg: normal.id, dep_kinds: [{ kind: null }] },
            { pkg: dev.id, dep_kinds: [{ kind: "dev" }] },
            { pkg: build.id, dep_kinds: [{ kind: "build" }] },
          ],
        },
        { id: normal.id, deps: [] },
        { id: dev.id, deps: [] },
        { id: build.id, deps: [] },
      ],
    },
  };
  await writeJson(configFile, {
    customNotices: [await realT3CodeNotice()],
    packageOverrides: [],
  });
  const generate = () =>
    generateThirdPartyLicenseManifest({
      configFile,
      packageManifests: [{ bundle: "web", path: appManifest }],
      cargo: { bundle: "desktop", metadata },
    });
  return { root, configFile, normalRoot, generate };
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) =>
        NodeFSP.rm(directory, { force: true, recursive: true }),
      ),
  );
});

describe("third-party license generation", () => {
  it("collects shipped npm packages, normally linked crates and the T3 Code notice", async () => {
    const fixture = await createFixture();
    const manifest = await fixture.generate();
    const t3License = await NodeFSP.readFile(T3_LICENSE, "utf8");

    assert.deepEqual(manifest, {
      schemaVersion: 1,
      entries: [
        {
          bundles: ["web"],
          kind: "package",
          license: "MIT",
          name: "demo-dependency",
          noticeText: "Demo MIT license text",
          sourceUrl: "https://github.com/example/demo-dependency",
          version: "1.2.3",
        },
        {
          bundles: ["desktop"],
          kind: "package",
          license: "MIT",
          name: "normal-crate",
          noticeText: "Normal crate text",
          sourceUrl: "https://github.com/example/normal-crate",
          version: "1.0.0",
        },
        {
          bundles: ["desktop", "web"],
          kind: "custom",
          license: "MIT",
          name: "T3 Code",
          noticeText: t3License.trim(),
          sourceUrl: "https://github.com/pingdotgg/t3code",
          version: "0.0.45",
        },
      ],
    });
    assert.match(
      manifest.entries[2]!.noticeText,
      /^Copyright \(c\) 2026 T3 Tools Inc\.$/m,
    );
  });

  it("fails naming the crate when a linked crate has no notice file", async () => {
    const fixture = await createFixture();
    await NodeFSP.rm(NodePath.join(fixture.normalRoot, "LICENSE"));

    await assert.rejects(
      fixture.generate(),
      /found 1 invalid package notice:\n- normal-crate@1\.0\.0 does not include a license or notice file/,
    );
  });

  it("renders generated notices from checked-in SPDX texts", async () => {
    const fixture = await createFixture();
    await NodeFSP.mkdir(NodePath.join(fixture.root, "third-party/spdx"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(fixture.root, "third-party/spdx/MIT.txt"),
      "MIT License\n\nCopyright (c) <year> <copyright holders>\n\nPermission text\n",
      "utf8",
    );
    await writeJson(fixture.configFile, {
      customNotices: [],
      packageOverrides: [
        {
          repositoryUrl: "https://github.com/example/normal-crate",
          generatedNotice: {
            licenseId: "MIT",
            copyrights: ["Copyright (c) 2026 Example Author"],
          },
        },
      ],
    });

    const manifest = await fixture.generate();

    assert.equal(
      manifest.entries.find((entry) => entry.name === "normal-crate")
        ?.noticeText,
      "MIT License\n\nCopyright (c) 2026 Example Author\n\nPermission text",
    );
  });

  it("fails when a generated notice has no checked-in SPDX text", async () => {
    const fixture = await createFixture();
    await writeJson(fixture.configFile, {
      customNotices: [],
      packageOverrides: [
        { name: "normal-crate", generatedNotice: { licenseId: "MPL-2.0" } },
      ],
    });

    await assert.rejects(
      fixture.generate(),
      /SPDX license text MPL-2\.0 is missing/,
    );
  });
});
