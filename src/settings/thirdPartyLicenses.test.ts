// Ported from T3 Code v0.0.45 packages/shared/src/thirdPartyLicenses.test.ts (MIT).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeThirdPartyLicenseManifest,
  filterThirdPartyLicenseEntries,
  formatLicenseBundles,
  thirdPartyLicenseEntryKey,
  type ThirdPartyLicenseEntry,
} from "./thirdPartyLicenses";

const ENTRIES: ReadonlyArray<ThirdPartyLicenseEntry> = [
  {
    bundles: ["web"],
    kind: "package",
    license: "MIT",
    name: "react",
    noticeText: "React license",
    sourceUrl: "https://react.dev",
    version: "19.2.6",
  },
  {
    bundles: ["assets", "desktop"],
    kind: "custom",
    license: "CC-BY-4.0",
    name: "sample-icons",
    noticeText: "Icon notice",
    sourceUrl: null,
    version: null,
  },
];
const [react, icons] = ENTRIES as [
  ThirdPartyLicenseEntry,
  ThirdPartyLicenseEntry,
];

describe("third-party license manifests", () => {
  it("decodes the generated manifest shape", () => {
    assert.deepEqual(
      decodeThirdPartyLicenseManifest({ schemaVersion: 1, entries: ENTRIES }),
      { schemaVersion: 1, entries: ENTRIES },
    );
  });

  it("rejects unsupported manifest versions", () => {
    assert.throws(
      () => decodeThirdPartyLicenseManifest({ schemaVersion: 2, entries: [] }),
      /unsupported format/,
    );
  });

  it("rejects unsafe source links", () => {
    assert.throws(
      () =>
        decodeThirdPartyLicenseManifest({
          schemaVersion: 1,
          entries: [{ ...react, sourceUrl: "javascript:alert(1)" }],
        }),
      /invalid shape/,
    );
  });

  it("rejects duplicate navigation keys", () => {
    assert.throws(
      () =>
        decodeThirdPartyLicenseManifest({
          schemaVersion: 1,
          entries: [react, react],
        }),
      /duplicate entry/,
    );
  });

  it("filters by package, license, version, and bundle", () => {
    assert.deepEqual(filterThirdPartyLicenseEntries(ENTRIES, "react 19.2"), [
      react,
    ]);
    assert.deepEqual(filterThirdPartyLicenseEntries(ENTRIES, "cc-by desktop"), [
      icons,
    ]);
    assert.deepEqual(filterThirdPartyLicenseEntries(ENTRIES, "apache"), []);
  });

  it("formats bundle names for display", () => {
    assert.equal(
      formatLicenseBundles([
        "assets",
        "desktop",
        "web",
        "plugin",
        "constructor",
      ]),
      "Assets, Desktop, Web, plugin, constructor",
    );
  });

  it("uses path-safe navigation keys for scoped packages", () => {
    assert.ok(
      !thirdPartyLicenseEntryKey({ ...react, name: "@scope/package" }).includes(
        "/",
      ),
    );
  });

  it("uses distinct navigation keys when names and versions contain delimiters", () => {
    const first = thirdPartyLicenseEntryKey({
      ...react,
      name: "a:1",
      version: null,
    });
    const second = thirdPartyLicenseEntryKey({
      ...react,
      name: "a",
      version: "1:custom",
    });
    assert.notEqual(first, second);
  });
});
