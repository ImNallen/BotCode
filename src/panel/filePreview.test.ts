import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fileContent,
  fileKind,
  fileSurfaceView,
  isRevealPending,
  parseDelimitedPreview,
  rebaseDocumentLink,
  RENDER_PREFERENCES,
  resolveDocumentPath,
  type FileKind,
} from "./filePreview";

const shown = { preferred: true, revealPending: false, textShown: true };

describe("fileKind", () => {
  it("classifies T3's image, audio, markdown, table and html extensions without letter case", () => {
    for (const path of [
      "icon.png",
      "photo.JPEG",
      "animation.gif",
      "vector.svg",
      "texture.webp",
      "image.avif",
      "favicon.ico",
      "a.jpg",
    ])
      assert.deepEqual(fileKind(path), { kind: "image" }, path);
    for (const path of [
      "notes/recording.WAV",
      "a.mp3",
      "a.ogg",
      "a.oga",
      "a.flac",
      "a.aac",
      "a.m4a",
      "a.opus",
      "a.aiff",
    ])
      assert.deepEqual(fileKind(path), { kind: "audio" }, path);
    assert.deepEqual(fileKind("README.md"), { kind: "markdown" });
    assert.deepEqual(fileKind("docs/guide.MDX"), { kind: "markdown" });
    assert.deepEqual(fileKind("data.CSV"), { kind: "table", delimiter: "," });
    assert.deepEqual(fileKind("data.tsv"), { kind: "table", delimiter: "\t" });
    assert.deepEqual(fileKind("report.html"), { kind: "html" });
    assert.deepEqual(fileKind("report.HTM"), { kind: "html" });
  });

  it("leaves pdf, video and look-alike names as source", () => {
    for (const path of [
      "report.pdf",
      "clip.mp4",
      "image.png.ts",
      "recording.wav.ts",
      "png",
      "docs/guide.txt",
      "docs/markdown.ts",
      "vector.svg#mark",
    ])
      assert.deepEqual(fileKind(path), { kind: "source" }, path);
  });
});

describe("fileSurfaceView", () => {
  const view = (kind: FileKind, state = shown) => fileSurfaceView(kind, state);

  it("uses T3's toggle copy and icons for each rendered mode", () => {
    const cases: [FileKind, string, string, string, string][] = [
      [
        { kind: "markdown" },
        "Show markdown source",
        "Show rendered markdown",
        "eye",
        "markdown",
      ],
      [
        { kind: "table", delimiter: "," },
        "Show source",
        "Show table",
        "table",
        "table",
      ],
      [
        { kind: "html" },
        "Show HTML source",
        "Show rendered page",
        "eye",
        "frame",
      ],
    ];
    for (const [kind, renderedLabel, sourceLabel, sourceIcon, body] of cases) {
      const rendered = view(kind);
      assert.deepEqual(rendered.toggle?.label, renderedLabel);
      assert.equal(rendered.toggle?.rendered, true);
      assert.equal(rendered.toggle?.icon, "code");
      assert.equal(rendered.body.kind, body);
      const source = view(kind, { ...shown, preferred: false });
      assert.equal(source.toggle?.label, sourceLabel);
      assert.equal(source.toggle?.rendered, false);
      assert.equal(source.toggle?.icon, sourceIcon);
      assert.equal(source.body.kind, "editor");
    }
  });

  it("shows word wrap only over source text the editor shows", () => {
    assert.equal(view({ kind: "markdown" }).wordWrap, false);
    assert.equal(view({ kind: "table", delimiter: "," }).wordWrap, false);
    assert.equal(view({ kind: "html" }).wordWrap, false);
    assert.equal(view({ kind: "image" }).wordWrap, false);
    assert.equal(view({ kind: "audio" }).wordWrap, false);
    assert.equal(
      view({ kind: "markdown" }, { ...shown, preferred: false }).wordWrap,
      true,
    );
    assert.equal(view({ kind: "source" }).wordWrap, true);
    assert.equal(
      view({ kind: "source" }, { ...shown, textShown: false }).wordWrap,
      false,
      "a loading or failed read has no text to wrap",
    );
  });

  it("gives media and plain source no rendered toggle", () => {
    assert.deepEqual(view({ kind: "image" }), {
      body: { kind: "image" },
      toggle: null,
      wordWrap: false,
    });
    assert.equal(view({ kind: "audio" }).toggle, null);
    assert.equal(view({ kind: "source" }).toggle, null);
    assert.equal(view({ kind: "source" }).body.kind, "editor");
  });

  it("keeps the table delimiter on the rendered body", () => {
    assert.deepEqual(view({ kind: "table", delimiter: "\t" }).body, {
      kind: "table",
      delimiter: "\t",
    });
  });

  it("a pending reveal shows source until the toggle is pressed for that path and sequence", () => {
    const pending = isRevealPending(12, null, "README.md", 3);
    assert.equal(pending, true);
    const revealed = view(
      { kind: "markdown" },
      { ...shown, revealPending: pending },
    );
    assert.equal(revealed.body.kind, "editor");
    assert.equal(revealed.toggle?.rendered, false);
    const handled = { path: "README.md", sequence: 3 };
    assert.equal(isRevealPending(12, handled, "README.md", 3), false);
    assert.equal(
      isRevealPending(12, handled, "README.md", 4),
      true,
      "a new reveal on the same file wins again",
    );
    assert.equal(
      isRevealPending(12, handled, "docs/other.md", 3),
      true,
      "one file's handled reveal does not swallow another file's",
    );
    assert.equal(isRevealPending(null, null, "README.md", 3), false);
  });

  it("defaults to source for Markdown and rendered for tables and HTML under z1 keys", () => {
    assert.deepEqual(RENDER_PREFERENCES, {
      markdown: { key: "z1.renderMarkdown", fallback: false },
      table: { key: "z1.renderTable", fallback: true },
      html: { key: "z1.renderBrowserFile", fallback: true },
    });
  });
});

describe("parseDelimitedPreview", () => {
  it("preserves quoted separators, escaped quotes, blank cells and line breaks", () => {
    assert.deepEqual(
      parseDelimitedPreview(
        '\ufeffname,notes,empty\r\n"A, B","say ""hi""\nagain",\r\n',
        ",",
      ),
      {
        rows: [
          ["name", "notes", "empty"],
          ["A, B", 'say "hi"\nagain', ""],
        ],
        truncated: false,
      },
    );
    assert.deepEqual(parseDelimitedPreview("one\ttwo\n\tthree", "\t").rows, [
      ["one", "two"],
      ["", "three"],
    ]);
  });

  for (const delimiter of [",", "\t"] as const) {
    it(`preserves a final quoted empty record without a line ending (${JSON.stringify(delimiter)})`, () => {
      for (const ending of ["", "\n", "\r\n"])
        assert.deepEqual(
          parseDelimitedPreview(`name\r\nAlice\r\n""${ending}`, delimiter),
          { rows: [["name"], ["Alice"], [""]], truncated: false },
        );
      assert.deepEqual(parseDelimitedPreview('""', delimiter), {
        rows: [[""]],
        truncated: false,
      });
    });

    it(`does not invent records for empty input or a trailing line ending (${JSON.stringify(delimiter)})`, () => {
      for (const prefix of ["", "\ufeff"]) {
        assert.deepEqual(parseDelimitedPreview(prefix, delimiter).rows, []);
        assert.deepEqual(
          parseDelimitedPreview(`${prefix}name\r\n`, delimiter).rows,
          [["name"]],
        );
        assert.deepEqual(parseDelimitedPreview(`${prefix}""`, delimiter).rows, [
          [""],
        ]);
      }
    });

    it(`keeps a quoted empty record at the row limit (${JSON.stringify(delimiter)})`, () => {
      const text = `${"name\n".repeat(99)}""`;
      const preview = parseDelimitedPreview(text, delimiter);
      assert.equal(preview.rows.length, 100);
      assert.deepEqual(preview.rows.at(-1), [""]);
      assert.equal(preview.truncated, false);
      assert.equal(
        parseDelimitedPreview(`${text}\nextra`, delimiter).truncated,
        true,
      );
    });
  }

  it("bounds rows, columns and cell length and reports partial content", () => {
    const table = parseDelimitedPreview(
      Array.from({ length: 101 }, () =>
        Array.from({ length: 31 }, () => "x".repeat(2001)).join(","),
      ).join("\n"),
      ",",
    );
    assert.equal(table.truncated, true);
    assert.equal(table.rows.length, 100);
    assert.equal(table.rows[0]?.length, 30);
    assert.equal(table.rows[0]?.[0]?.length, 2000);
    assert.equal(parseDelimitedPreview('a,"unfinished', ",").truncated, true);
  });
});

describe("document-relative paths", () => {
  it("resolves Markdown images against the document's folder", () => {
    const resolve = (target: string) =>
      resolveDocumentPath("docs/README.md", target);
    assert.equal(resolve("./a.png"), "docs/a.png");
    assert.equal(resolve("a.png"), "docs/a.png");
    assert.equal(resolve("../logo.png"), "logo.png");
    assert.equal(resolve("/assets/x.png"), "assets/x.png");
    assert.equal(resolve("my%20pic.png"), "docs/my pic.png");
    assert.equal(resolve("img/a.png?raw=1#top"), "docs/img/a.png");
    assert.equal(resolve("100%.png"), "docs/100%.png");
    assert.equal(resolveDocumentPath("README.md", "logo.png"), "logo.png");
  });

  it("refuses URLs, fragments and paths that climb out of the checkout", () => {
    for (const target of [
      "../../x.png",
      "https://example.com/a.png",
      "data:image/png;base64,AA",
      "//cdn.example.com/a.png",
      "#frag",
      "",
      "..",
    ])
      assert.equal(resolveDocumentPath("docs/README.md", target), null, target);
  });

  it("rebases relative links and inline paths, keeping their position", () => {
    const rebase = (target: string) =>
      rebaseDocumentLink("docs/guide/README.md", target);
    assert.equal(rebase("../api.md#L10"), "docs/api.md#L10");
    assert.equal(rebase("./setup.ts:12"), "docs/guide/setup.ts:12");
    assert.equal(rebase("my%20file.md"), "docs/guide/my%20file.md");
    assert.equal(rebase("../../../x.md"), null);
    for (const passthrough of [
      "/Users/me/project/src/main.ts",
      "https://example.com",
      "file:///tmp/a.ts",
      "#section",
      "C:\\repo\\a.ts",
    ])
      assert.equal(rebase(passthrough), passthrough);
  });
});

describe("fileContent", () => {
  const query = (data: unknown, error: Error | null = null) => ({
    data: data as never,
    error,
    isPending: data === undefined && error === null,
  });
  const text = (contents: string) => ({ kind: "text", name: "f", contents });

  it("shows draft text but keys the disk revision off the confirmed read", () => {
    assert.deepEqual(
      fileContent({ contents: "draft", confirmed: false }, query(text("disk"))),
      { kind: "text", contents: "draft", confirmedDisk: "disk" },
    );
    assert.deepEqual(fileContent(undefined, query(text("disk"))), {
      kind: "text",
      contents: "disk",
      confirmedDisk: "disk",
    });
  });

  it("reports media, failures and pending reads", () => {
    assert.deepEqual(
      fileContent(
        undefined,
        query({ kind: "media", name: "a.png", revision: "4-1" }),
      ),
      { kind: "media", revision: "4-1" },
    );
    assert.deepEqual(
      fileContent(undefined, query({ kind: "unavailable", reason: "Too big" })),
      { kind: "failure", reason: "Too big" },
    );
    assert.deepEqual(
      fileContent(undefined, query(text("stale"), new Error("Gone"))),
      { kind: "failure", reason: "Gone" },
      "a failed refetch does not keep showing stale text",
    );
    assert.deepEqual(fileContent(undefined, query(undefined)), {
      kind: "pending",
    });
  });
});
