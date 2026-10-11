// Ported from T3 Code v0.0.45 packages/shared/src/composerInlineTokens.ts and apps/web/src/composer-rich-text-doc.ts (MIT).
import type { JSONContent } from "@tiptap/core";
import { Code } from "@tiptap/extension-code";
import { TaskItem } from "@tiptap/extension-task-item";
import {
  Slice,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { Transform } from "@tiptap/pm/transform";
import { pathBasename } from "./composer-logic";
import { SKILL_TOKEN_REGEX } from "./composerSkillTokens";
import {
  parseInlineMarkdown,
  RICH_TEXT_DELIMITERS,
  type RichTextMark,
} from "./composerRichText";
import {
  composerContextRecord,
  truncateContextText,
  contextReferences,
  type ComposerContextRecord,
} from "./composerContext";

export function composerSkills(text: string) {
  return Array.from(text.matchAll(SKILL_TOKEN_REGEX), (match) => {
    const start = match.index + (match[1]?.length ?? 0);
    const end = match.index + match[0].length;
    return { start, end, name: match[2] ?? "", source: text.slice(start, end) };
  });
}

const fileLink = /(^|\s)\[((?:\\.|[^\]\\]){0,512})\]\(([^)\s]+)\)(?=\s|$)/g;
const quotedMention = /(^|\s)@"((?:\\.|[^"\\])*)"(?=\s|$)/g;
type Mention = { start: number; end: number; path: string; source: string };

export function composerMentions(text: string): Mention[] {
  const mentions: Mention[] = [];
  for (const match of text.matchAll(fileLink)) {
    const label = (match[2] ?? "").replace(/\\(.)/g, "$1");
    let path = match[3] ?? "";
    try {
      path = decodeURIComponent(path);
    } catch {
      continue;
    }
    if (
      !path ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) ||
      label !== pathBasename(path)
    )
      continue;
    const start = match.index + (match[1]?.length ?? 0);
    const end = match.index + match[0].length;
    mentions.push({ start, end, path, source: text.slice(start, end) });
  }
  for (const match of text.matchAll(quotedMention)) {
    const path = (match[2] ?? "").replace(/\\(.)/g, "$1");
    if (!path) continue;
    const start = match.index + (match[1]?.length ?? 0);
    const end = match.index + match[0].length;
    mentions.push({ start, end, path, source: text.slice(start, end) });
  }
  return mentions.sort((a, b) => a.start - b.start);
}

function legacyId(kind: string, value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++)
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `legacy_${kind}_${(hash >>> 0).toString(16)}`;
}

/** Outermost mark first, so closers mirror openers when nested. */
const MARK_NESTING_ORDER: RichTextMark[] = ["strike", "bold", "italic", "code"];
const TIPTAP_TO_MARK: Record<string, RichTextMark> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
};

/**
 * Tiptap's code mark excludes every other mark, which rejects the `bold+code`
 * spans markdown like `**\`x\`**` parses into and drops the whole insert.
 * Code nests inside emphasis here, so it only excludes itself like the rest.
 */
export const ComposerCodeExtension = Code.extend({ excludes: "code" });

/**
 * Task list items keep their exact source indent in an attribute so nesting
 * round-trips byte-identically.
 */
export const ComposerTaskItemExtension = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      indent: { default: "" },
      markerSpace: { default: " " },
      contentSpace: { default: null },
    };
  },
}).configure({ nested: true });

type TaskLinePrefix = {
  indent: string;
  checked: boolean;
  markerSpace: string;
  contentSpace: string;
};

function parseTaskPrefix(
  head: string,
): { prefix: TaskLinePrefix; markerLength: number } | null {
  const match = head.match(/^([ \t]*)-([ \t]+)\[([ xX])\]([ \t]*)/);
  if (!match) return null;
  const after = head.slice(match[0].length);
  if (after.length > 0 && !match[4]) return null;
  return {
    prefix: {
      indent: match[1] ?? "",
      checked: (match[3] ?? " ").toLowerCase() === "x",
      markerSpace: match[2]!,
      contentSpace: match[4]!,
    },
    markerLength: match[0].length,
  };
}

type PendingTaskItem = TaskLinePrefix & {
  content: JSONContent[];
  children: PendingTaskItem[];
};

function taskListJson(items: PendingTaskItem[]): JSONContent {
  return {
    type: "taskList",
    content: items.map((item) => ({
      type: "taskItem",
      attrs: {
        checked: item.checked,
        indent: item.indent,
        markerSpace: item.markerSpace,
        contentSpace: item.contentSpace,
      },
      content: [
        { type: "paragraph", content: item.content },
        ...(item.children.length > 0 ? [taskListJson(item.children)] : []),
      ],
    })),
  };
}

function markJson(marks: RichTextMark[]) {
  return marks.length > 0
    ? {
        marks: [...marks]
          .sort(
            (a, b) =>
              MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b),
          )
          .map((mark) => ({ type: mark })),
      }
    : {};
}

function lineAtoms(
  line: string,
  byId: Map<string, ComposerContextRecord>,
): JSONContent[] {
  const atoms: JSONContent[] = [];
  let cursor = 0;
  const mentions = [
    ...contextReferences(line).map((reference) => ({
      ...reference,
      record: byId.get(reference.contextId) ?? null,
    })),
    ...composerMentions(line).map((mention) => ({
      ...mention,
      record: {
        version: 1,
        kind: "mention",
        contextId: legacyId("mention", mention.path),
        label: truncateContextText(pathBasename(mention.path), 200),
        path: mention.path,
      } satisfies ComposerContextRecord,
    })),
    ...composerSkills(line)
      .filter((mention) => mention.end < line.length)
      .map((mention) => ({
        ...mention,
        record: {
          version: 1,
          kind: "skill",
          contextId: legacyId("skill", mention.name),
          label: truncateContextText(mention.name, 200),
          name: mention.name,
        } satisfies ComposerContextRecord,
      })),
  ].sort((a, b) => a.start - b.start);
  for (const mention of mentions) {
    if (mention.start < cursor) continue;
    if (mention.start > cursor)
      atoms.push({ type: "text", text: line.slice(cursor, mention.start) });
    atoms.push({ type: "composer-context", attrs: mention });
    cursor = mention.end;
  }
  if (cursor < line.length)
    atoms.push({ type: "text", text: line.slice(cursor) });
  return atoms;
}

// Styling parses the supported inline Markdown into marks and `- [ ]` lines
// into task lists; the plain editor's schema has neither.
export function buildComposerDocument(
  value: string,
  records: readonly ComposerContextRecord[] = [],
  options: { styling?: boolean } = {},
): JSONContent {
  const styling = options.styling ?? false;
  const byId = new Map(records.map((record) => [record.contextId, record]));
  // Hide chip source from the markdown parser, then restore the chips with
  // the marks of their surrounding text. Choose a sentinel absent from input.
  let sentinel = "￼";
  for (let codePoint = 0xe000; value.includes(sentinel); codePoint += 1)
    sentinel = String.fromCodePoint(codePoint);
  const lines = value.split("\n").map((line) => {
    const parsed = styling ? parseTaskPrefix(line) : null;
    const content = parsed ? line.slice(parsed.markerLength) : line;
    const chips: JSONContent[] = [];
    const hidden = lineAtoms(content, byId)
      .map((node) => {
        if (node.type === "text") return node.text ?? "";
        chips.push(node);
        return sentinel;
      })
      .join("");
    const spans = styling
      ? parseInlineMarkdown(hidden)
      : [{ text: hidden, marks: [] as RichTextMark[] }];
    const inline: JSONContent[] = [];
    let chip = 0;
    for (const span of spans)
      span.text.split(sentinel).forEach((piece, index) => {
        if (index > 0)
          inline.push({ ...chips[chip++]!, ...markJson(span.marks) });
        if (piece)
          inline.push({ type: "text", text: piece, ...markJson(span.marks) });
      });
    return { task: parsed?.prefix ?? null, inline };
  });

  // Consecutive task lines group into (possibly nested) task lists by indent
  // prefix; everything else stays a paragraph.
  const blocks: JSONContent[] = [];
  let stack: { indent: string; items: PendingTaskItem[] }[] = [];
  const flushTasks = () => {
    if (stack.length > 0) {
      blocks.push(taskListJson(stack[0]!.items));
      stack = [];
    }
  };
  for (const line of lines) {
    if (!line.task) {
      flushTasks();
      blocks.push({ type: "paragraph", content: line.inline });
      continue;
    }
    const item: PendingTaskItem = {
      ...line.task,
      content: line.inline,
      children: [],
    };
    for (;;) {
      const top = stack[stack.length - 1];
      if (!top) {
        // A leading indented item with no parent flattens but keeps indent.
        stack.push({ indent: item.indent, items: [] });
        continue;
      }
      if (top.indent === item.indent) {
        top.items.push(item);
        break;
      }
      if (top.indent !== "" && !item.indent.startsWith(top.indent)) {
        if (stack.length > 1) {
          stack.pop();
          continue;
        }
        top.indent = item.indent;
        top.items.push(item);
        break;
      }
      const parent = top.items[top.items.length - 1];
      if (!parent) {
        top.items.push(item);
        break;
      }
      parent.children.push(item);
      stack.push({ indent: item.indent, items: parent.children });
      break;
    }
  }
  flushTasks();
  return { type: "doc", content: blocks };
}

export function replaceComposerText(
  tr: Transaction,
  input: {
    start: number;
    end: number;
    expectedText: string;
    replacement: string;
    records?: ComposerContextRecord[];
  },
): boolean {
  const current = composerDocumentMap(tr.doc).text;
  if (
    input.start < 0 ||
    input.end < input.start ||
    input.end > current.length ||
    current.slice(input.start, input.end) !== input.expectedText
  )
    return false;
  const from = editorCursor(tr.doc, input.start);
  const to = editorCursor(tr.doc, input.end);
  const content = composerContent(
    tr.doc.type.schema,
    input.replacement,
    input.records,
  ).content;
  const slice = new Slice(content, 1, 1);
  const candidate = new Transform(tr.doc).replaceRange(from, to, slice);
  if (composerDocumentMap(candidate.doc).records.length > 200) return false;
  const stepCount = tr.steps.length;
  closeHistory(tr).replaceRange(from, to, slice);
  tr.setSelection(
    TextSelection.near(tr.doc.resolve(tr.mapping.slice(stepCount).map(to, 1))),
  );
  return true;
}

// The prompt Codex receives must not depend on the setting, so Markdown the
// serializer would not reproduce byte for byte (`__x__`, `a * b * c`) stays
// literal text rather than being styled.
export function composerContent(
  schema: Schema,
  value: string,
  records: readonly ComposerContextRecord[] = [],
): ProseMirrorNode {
  if (schema.marks.bold !== undefined) {
    const styled = schema.nodeFromJSON(
      buildComposerDocument(value, records, { styling: true }),
    );
    if (composerDocumentMap(styled).text === value) return styled;
  }
  return schema.nodeFromJSON(buildComposerDocument(value, records));
}

// Offsets: flat counts document characters (chips 1, markers excluded);
// prompt offsets count the Markdown the composer reports (markers literal,
// chips expand to their source).
type Run = {
  kind: "text" | "token" | "break" | "prefix";
  flatStart: number;
  docLen: number;
  promptStart: number;
  promptLen: number;
  openLen: number;
  closeLen: number;
  pmPos: number;
};
type Accumulator = {
  runs: Run[];
  text: string;
  flat: number;
  records: Map<string, ComposerContextRecord>;
};

function pushBreakRun(acc: Accumulator, position?: number) {
  const previous = acc.runs[acc.runs.length - 1];
  acc.runs.push({
    kind: "break",
    flatStart: acc.flat,
    docLen: 1,
    promptStart: acc.text.length,
    promptLen: 1,
    openLen: 0,
    closeLen: 0,
    pmPos: position ?? (previous ? previous.pmPos + previous.docLen : 1),
  });
  acc.text += "\n";
  acc.flat += 1;
}

function chipSource(node: ProseMirrorNode, acc: Accumulator): string {
  const result = composerContextRecord.safeParse(node.attrs.record);
  if (result.success) acc.records.set(result.data.contextId, result.data);
  return typeof node.attrs.source === "string" ? node.attrs.source : "";
}

function appendInlineRuns(
  container: ProseMirrorNode,
  contentStart: number,
  acc: Accumulator,
) {
  const children: ProseMirrorNode[] = [];
  container.forEach((child) => {
    if (
      !child.isText ||
      child.marks.some((mark) => mark.type.name === "code")
    ) {
      children.push(child);
      return;
    }
    // Separate boundary whitespace so delimiters can move past it without
    // changing the document offsets or marks on the visible text.
    const text = child.text!;
    const start = text.length - text.trimStart().length;
    const end = Math.max(start, text.trimEnd().length);
    let offset = 0;
    for (const boundary of [start, end, text.length]) {
      if (boundary > offset) children.push(child.cut(offset, boundary));
      offset = boundary;
    }
  });
  // Emphasis cannot open or close next to whitespace. Retain a whitespace
  // mark only when its range has visible content on both sides.
  for (const mark of MARK_NESTING_ORDER) {
    if (mark === "code") continue;
    for (const direction of [1, -1]) {
      let hasContent = false;
      for (
        let index = direction === 1 ? 0 : children.length - 1;
        index >= 0 && index < children.length;
        index += direction
      ) {
        const child = children[index]!;
        if (
          child.type.name === "hardBreak" ||
          !child.marks.some((item) => item.type.name === mark)
        ) {
          hasContent = false;
        } else if (
          child.isText &&
          !child.marks.some((item) => item.type.name === "code") &&
          /^\s+$/.test(child.text!)
        ) {
          if (!hasContent)
            children[index] = child.mark(
              child.marks.filter((item) => item.type.name !== mark),
            );
        } else {
          hasContent = true;
        }
      }
    }
  }
  // Longer shared marks surround shorter ones. This keeps both nested
  // formatting and formatting across chips inside a single delimiter pair.
  const markEnds = new Map<RichTextMark, number>();
  const orderedMarks: RichTextMark[][] = [];
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]!;
    const marks =
      child.type.name === "hardBreak"
        ? []
        : child.marks
            .map((mark) => TIPTAP_TO_MARK[mark.type.name])
            .filter((mark): mark is RichTextMark => Boolean(mark));
    for (const mark of MARK_NESTING_ORDER) {
      if (!marks.includes(mark)) markEnds.delete(mark);
      else if (!markEnds.has(mark)) markEnds.set(mark, index);
    }
    orderedMarks[index] = marks.sort(
      (a, b) =>
        markEnds.get(b)! - markEnds.get(a)! ||
        MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b),
    );
  }
  for (let index = 1; index < orderedMarks.length; index += 1) {
    const marks = orderedMarks[index]!;
    const retained: RichTextMark[] = [];
    for (const mark of orderedMarks[index - 1]!) {
      if (!marks.includes(mark)) break;
      retained.push(mark);
    }
    orderedMarks[index] = [
      ...retained,
      ...marks.filter((mark) => !retained.includes(mark)),
    ];
  }
  const commonLength = (left: RichTextMark[], right: RichTextMark[]) => {
    let index = 0;
    while (index < left.length && left[index] === right[index]) index += 1;
    return index;
  };
  let inlineOffset = 0;
  children.forEach((child, index) => {
    const pmPos = contentStart + inlineOffset;
    inlineOffset += child.nodeSize;
    if (child.type.name === "hardBreak") {
      pushBreakRun(acc, pmPos);
      return;
    }
    const marks = orderedMarks[index]!;
    const open = marks
      .slice(commonLength(marks, orderedMarks[index - 1] ?? []))
      .map((mark) => RICH_TEXT_DELIMITERS[mark])
      .join("");
    const close = marks
      .slice(commonLength(marks, orderedMarks[index + 1] ?? []))
      .toReversed()
      .map((mark) => RICH_TEXT_DELIMITERS[mark])
      .join("");
    const source = child.isText ? child.text! : chipSource(child, acc);
    const docLen = child.isText ? source.length : 1;
    const prompt = open + source + close;
    acc.runs.push({
      kind: child.isText ? "text" : "token",
      flatStart: acc.flat,
      docLen,
      promptStart: acc.text.length,
      promptLen: prompt.length,
      openLen: open.length,
      closeLen: close.length,
      pmPos,
    });
    acc.text += prompt;
    acc.flat += docLen;
  });
  // Empty paragraphs have an editable position even though they emit no text.
  if (children.length === 0)
    acc.runs.push({
      kind: "text",
      flatStart: acc.flat,
      docLen: 0,
      promptStart: acc.text.length,
      promptLen: 0,
      openLen: 0,
      closeLen: 0,
      pmPos: contentStart,
    });
}

function walkTaskList(
  list: ProseMirrorNode,
  listStart: number,
  acc: Accumulator,
) {
  let itemPos = listStart + 1;
  let firstItem = true;
  list.content.forEach((item) => {
    // Sibling items are separated by one newline in every coordinate space.
    if (!firstItem) pushBreakRun(acc);
    firstItem = false;
    const itemContentStart = itemPos + 1;
    const first = item.firstChild;
    const empty =
      first?.type.name === "paragraph" && first.content.childCount === 0;
    const attrs = item.attrs as Record<string, unknown>;
    const indent = typeof attrs.indent === "string" ? attrs.indent : "";
    const markerSpace =
      typeof attrs.markerSpace === "string" ? attrs.markerSpace : " ";
    const contentSpace =
      typeof attrs.contentSpace === "string"
        ? attrs.contentSpace || (empty ? "" : " ")
        : empty
          ? ""
          : " ";
    const prefix = `${indent}-${markerSpace}[${attrs.checked === true ? "x" : " "}]${contentSpace}`;
    // The checkbox owns no document characters; every prefix offset clamps
    // to the start of the item text, exactly like style markers.
    acc.runs.push({
      kind: "prefix",
      flatStart: acc.flat,
      docLen: 0,
      promptStart: acc.text.length,
      promptLen: prefix.length,
      openLen: 0,
      closeLen: 0,
      pmPos: itemContentStart + 1,
    });
    acc.text += prefix;
    let childPos = itemContentStart;
    let firstBlock = true;
    item.content.forEach((child) => {
      if (!firstBlock) pushBreakRun(acc);
      firstBlock = false;
      if (child.type.name === "taskList") walkTaskList(child, childPos, acc);
      else if (child.type.name === "paragraph")
        appendInlineRuns(child, childPos + 1, acc);
      childPos += child.nodeSize;
    });
    itemPos += item.nodeSize;
  });
}

export function composerDocumentMap(doc: ProseMirrorNode) {
  const acc: Accumulator = { runs: [], text: "", flat: 0, records: new Map() };
  let blockStart = 0;
  doc.forEach((block, _offset, index) => {
    if (index > 0) pushBreakRun(acc);
    if (block.type.name === "taskList") walkTaskList(block, blockStart, acc);
    else if (block.type.name === "paragraph")
      appendInlineRuns(block, blockStart + 1, acc);
    blockStart += block.nodeSize;
  });
  return {
    text: acc.text,
    records: [...acc.records.values()],
    runs: acc.runs,
    docLength: acc.flat,
  };
}
type ComposerDocumentMap = ReturnType<typeof composerDocumentMap>;

function pmToFlat(map: ComposerDocumentMap, pmPos: number): number {
  for (const run of map.runs) {
    if (pmPos >= run.pmPos && pmPos <= run.pmPos + run.docLen) {
      // A position on a chip's trailing edge belongs after the chip.
      if (run.kind === "token" && pmPos === run.pmPos + run.docLen)
        return run.flatStart + run.docLen;
      return run.flatStart + Math.min(pmPos - run.pmPos, run.docLen);
    }
  }
  // A paragraph boundary position belongs to the newline between paragraphs.
  let best = 0;
  for (const run of map.runs)
    if (run.pmPos <= pmPos) best = run.flatStart + run.docLen;
  return Math.max(0, Math.min(best, map.docLength));
}

function flatToPrompt(map: ComposerDocumentMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (bounded < run.flatStart + run.docLen)
      return (
        run.promptStart +
        (run.kind === "text" || run.kind === "token" ? run.openLen : 0) +
        (bounded - run.flatStart)
      );
  }
  const last = map.runs[map.runs.length - 1];
  return last ? last.promptStart + last.promptLen : 0;
}

function promptToFlat(map: ComposerDocumentMap, offset: number): number {
  for (const run of map.runs) {
    if (offset < run.promptStart + run.promptLen) {
      // Checkbox prefixes and style markers are shown, never edited: every
      // offset inside them clamps to the adjacent document position.
      if (run.kind === "prefix") return run.flatStart;
      if (run.kind === "break")
        return run.flatStart + (offset - run.promptStart);
      const within = offset - run.promptStart;
      if (within <= run.openLen) return run.flatStart;
      if (run.kind === "token" || within >= run.promptLen - run.closeLen)
        return run.flatStart + run.docLen;
      return run.flatStart + (within - run.openLen);
    }
  }
  return map.docLength;
}

function flatToPm(map: ComposerDocumentMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs)
    if (bounded < run.flatStart + run.docLen)
      return run.pmPos + (bounded - run.flatStart);
  const last = map.runs[map.runs.length - 1];
  return last ? last.pmPos + last.docLen : 1;
}

export function promptCursor(doc: ProseMirrorNode, position: number): number {
  const map = composerDocumentMap(doc);
  return flatToPrompt(map, pmToFlat(map, position));
}

export function editorCursor(doc: ProseMirrorNode, offset: number): number {
  const map = composerDocumentMap(doc);
  return flatToPm(map, promptToFlat(map, offset));
}
