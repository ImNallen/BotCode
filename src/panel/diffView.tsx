// Diff view chrome shared by the local Diff surface and the pull request Code tab, copied from
// pingdotgg/t3code v0.0.45 components/DiffPanel.tsx and lib/diffRendering.ts (MIT).
import type { FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewReactOptions } from "@pierre/diffs/react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  FolderTreeIcon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn";
import { storage } from "../lib/storage";
import { Button, Toggle } from "../ui/controls";
import { SegmentedGroup, storedFlag, useStoredState } from "./chrome";
import type { DiffFileTreeEntry } from "./DiffFileTree";
import { WORD_WRAP_KEY } from "./FilesSurface";
import { DIFF_VIEW_UNSAFE_CSS } from "./surfaceCss";

export function hash(input: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

export function treeStatus(
  fileDiff: FileDiffMetadata,
): DiffFileTreeEntry["status"] {
  switch (fileDiff.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
  }
}

function collapseIconClass(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "text-[var(--diffs-addition-base)]";
    case "deleted":
      return "text-[var(--diffs-deletion-base)]";
    case "change":
    case "rename-pure":
    case "rename-changed":
      return "text-[var(--diffs-modified-base)]";
    default:
      return "text-muted-foreground/80";
  }
}

export function useDiffViewPreferences() {
  const [split, setSplit] = useStoredState("z1.diffSplit", storedFlag(false));
  const [wordWrap, setWordWrap] = useState(() =>
    storedFlag(true)(storage.getItem(WORD_WRAP_KEY)),
  );
  const [ignoreWhitespace, setIgnoreWhitespace] = useStoredState(
    "z1.diffIgnoreWhitespace",
    storedFlag(true),
  );
  const [fileTreeOpen, setFileTreeOpen] = useStoredState(
    "z1.diffFileTreeOpen",
    storedFlag(false),
  );
  return {
    split,
    setSplit,
    wordWrap,
    setWordWrap,
    ignoreWhitespace,
    setIgnoreWhitespace,
    fileTreeOpen,
    setFileTreeOpen,
  };
}

export function diffViewOptions<LAnnotation>({
  split,
  wordWrap,
  theme,
}: {
  split: boolean;
  wordWrap: boolean;
  theme: "light" | "dark";
}): CodeViewReactOptions<LAnnotation, undefined> {
  return {
    diffStyle: split ? "split" : "unified",
    overflow: wordWrap ? "wrap" : "scroll",
    theme: theme === "dark" ? "pierre-dark" : "pierre-light",
    themeType: theme,
    stickyHeaders: true,
    unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
    itemMetrics: {
      diffHeaderHeight: 32,
      hunkSeparatorHeight: 24,
      spacing: 0,
      paddingTop: 0,
      paddingBottom: 8,
    },
    layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
  };
}

export function DiffFileChevron({
  path,
  fileDiff,
  collapsed,
  onToggle,
}: {
  path: string;
  fileDiff: FileDiffMetadata;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const Chevron = collapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <Button
      size="icon-micro"
      variant="ghost"
      className="-ms-0.5"
      aria-label={collapsed ? `Expand ${path}` : `Collapse ${path}`}
      aria-expanded={!collapsed}
      title={collapsed ? "Expand diff" : "Collapse diff"}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <Chevron className={cn("size-4", collapseIconClass(fileDiff))} />
    </Button>
  );
}

export function CollapseAllButton({
  allCollapsed,
  onToggle,
}: {
  allCollapsed: boolean;
  onToggle: () => void;
}) {
  const label = allCollapsed ? "Expand all files" : "Collapse all files";
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      {allCollapsed ? (
        <ChevronsUpDownIcon className="size-3.5" />
      ) : (
        <ChevronsDownUpIcon className="size-3.5" />
      )}
    </Button>
  );
}

export function DiffLayoutToggle({
  split,
  onChange,
}: {
  split: boolean;
  onChange: (split: boolean) => void;
}) {
  return (
    <SegmentedGroup label="Diff layout">
      <Toggle
        variant="segmented"
        size="segmented"
        data-size="segmented"
        data-variant="segmented"
        pressed={!split}
        aria-label="Stacked diff view"
        title="Stacked diff view"
        onClick={() => onChange(false)}
      >
        <Rows3Icon className="size-3.5" />
      </Toggle>
      <Toggle
        variant="segmented"
        size="segmented"
        data-size="segmented"
        data-variant="segmented"
        pressed={split}
        aria-label="Split diff view"
        title="Split diff view"
        onClick={() => onChange(true)}
      >
        <Columns2Icon className="size-3.5" />
      </Toggle>
    </SegmentedGroup>
  );
}

export function WordWrapToggle({
  wordWrap,
  onChange,
}: {
  wordWrap: boolean;
  onChange: (wordWrap: boolean) => void;
}) {
  return (
    <Toggle
      variant="ghost"
      size="sm"
      pressed={wordWrap}
      aria-label={
        wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"
      }
      title={wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
      onClick={() => onChange(!wordWrap)}
    >
      <TextWrapIcon className="size-3.5" />
    </Toggle>
  );
}

export function WhitespaceToggle({
  ignoreWhitespace,
  onChange,
}: {
  ignoreWhitespace: boolean;
  onChange: (ignoreWhitespace: boolean) => void;
}) {
  const label = ignoreWhitespace
    ? "Show whitespace changes"
    : "Hide whitespace changes";
  return (
    <Toggle
      variant="ghost"
      size="sm"
      pressed={ignoreWhitespace}
      aria-label={label}
      title={label}
      onClick={() => onChange(!ignoreWhitespace)}
    >
      <PilcrowIcon className="size-3.5" />
    </Toggle>
  );
}

export function FileTreeToggle({
  open,
  onChange,
}: {
  open: boolean;
  onChange: (open: boolean) => void;
}) {
  const label = open ? "Hide file tree" : "Show file tree";
  return (
    <Toggle
      variant="ghost"
      size="sm"
      pressed={open}
      aria-label={label}
      title={label}
      onClick={() => onChange(!open)}
    >
      <FolderTreeIcon className="size-3.5" />
    </Toggle>
  );
}
