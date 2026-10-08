import assert from "node:assert/strict";
import { it } from "node:test";
import type { Workspace } from "../ipc";
import {
  browsePath,
  directoryQuery,
  filterBrowseEntries,
  newThreadDestination,
} from "./projectNavigation";

const alpha: Workspace = {
  id: "alpha",
  label: "Alpha",
  root: "/tmp/alpha",
  kind: "repository",
};
const beta: Workspace = {
  id: "beta",
  label: "Beta",
  root: "/tmp/beta",
  kind: "repository",
};
const scratch: Workspace = {
  id: "scratch",
  label: "No project",
  root: "/tmp/scratch",
  kind: "scratch",
};

it("the all-projects button picks among repositories and keeps scoped and Shift creation direct", () => {
  const input = {
    currentId: beta.id,
    workspaces: [scratch, alpha, beta],
    scratchAvailable: true,
    shiftKey: false,
  };
  assert.deepEqual(newThreadDestination(input), { kind: "picker" });
  assert.deepEqual(newThreadDestination({ ...input, scopeId: alpha.id }), {
    kind: "workspace",
    id: alpha.id,
  });
  assert.deepEqual(newThreadDestination({ ...input, scopeId: scratch.id }), {
    kind: "workspace",
    id: scratch.id,
  });
  assert.deepEqual(newThreadDestination({ ...input, shiftKey: true }), {
    kind: "workspace",
    id: beta.id,
  });
  assert.deepEqual(
    newThreadDestination({
      ...input,
      currentId: alpha.id,
      workspaces: [scratch, alpha],
    }),
    { kind: "workspace", id: alpha.id },
  );
  assert.deepEqual(
    newThreadDestination({ ...input, currentId: scratch.id, shiftKey: true }),
    { kind: "scratch" },
  );
  assert.deepEqual(
    newThreadDestination({ ...input, currentId: undefined, workspaces: [] }),
    { kind: "scratch" },
  );
  assert.deepEqual(
    newThreadDestination({
      ...input,
      currentId: undefined,
      workspaces: [],
      scratchAvailable: false,
    }),
    { kind: "unavailable" },
  );
});

it("typed paths browse their parent and preserve the exact Add target", () => {
  for (const [query, directory, leaf] of [
    ["/tmp/Alpha", "/tmp/", "Alpha"],
    ["/tmp/Alpha/", "/tmp/Alpha/", ""],
    ["~/Alpha", "~/", "Alpha"],
    ["./Alpha", "./", "Alpha"],
    ["../Alpha/", "../Alpha/", ""],
    ["/", "/", ""],
  ]) {
    assert.deepEqual(browsePath(query ?? "", alpha.root), {
      kind: "path",
      directory,
      leaf,
      exact: query,
    });
  }
  assert.deepEqual(browsePath("~", undefined), {
    kind: "path",
    directory: "~/",
    leaf: "",
    exact: "~/",
  });
  assert.equal(browsePath("./Alpha", undefined).kind, "error");
  assert.equal(browsePath("../Alpha", undefined).kind, "error");
  assert.equal(browsePath("Alpha", alpha.root).kind, "error");
  assert.equal(directoryQuery("/tmp/Alpha"), "/tmp/Alpha/");
  assert.equal(directoryQuery("/"), "/");
});

it("browse paths accept Windows drives and backslash separators", () => {
  assert.deepEqual(browsePath("C:\\Users\\me\\Al", undefined), {
    kind: "path",
    directory: "C:\\Users\\me\\",
    leaf: "Al",
    exact: "C:\\Users\\me\\Al",
  });
  assert.deepEqual(browsePath("~\\src", undefined), {
    kind: "path",
    directory: "~\\",
    leaf: "src",
    exact: "~\\src",
  });
  assert.equal(browsePath(".\\Alpha", alpha.root).kind, "path");
  assert.equal(browsePath("C:Alpha", undefined).kind, "error");
  assert.equal(directoryQuery("C:\\Users\\me"), "C:\\Users\\me\\");
  assert.equal(directoryQuery("C:\\"), "C:\\");
});

it("directory filtering matches a prefix and shows hidden entries only for a dot prefix", () => {
  const entries = ["Alpha", "Alpine", "beta", ".cache", ".config"].map(
    (name) => ({ name, fullPath: `/tmp/${name}` }),
  );
  assert.deepEqual(
    filterBrowseEntries(entries, "aL").map((entry) => entry.name),
    ["Alpha", "Alpine"],
  );
  assert.deepEqual(
    filterBrowseEntries(entries, "").map((entry) => entry.name),
    ["Alpha", "Alpine", "beta"],
  );
  assert.deepEqual(
    filterBrowseEntries(entries, ".c").map((entry) => entry.name),
    [".cache", ".config"],
  );
  assert.deepEqual(filterBrowseEntries(entries, "ph"), []);
});
