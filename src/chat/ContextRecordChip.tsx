// Ported from T3 Code v0.0.45 apps/web/src/components/ContextChip.tsx and AssistantCitationChip.tsx (MIT).
import {
  GitPullRequestIcon,
  MessageSquareIcon,
  QuoteIcon,
  TerminalIcon,
  FileIcon,
} from "lucide-react";
import type { Skill } from "../ipc";
import { FileEntryIcon } from "../panel/FileEntryIcon";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { SkillChipIcon } from "./SkillInlineText";
import { formatProviderSkillDisplayName } from "./providerSkills";
import type { ComposerContextRecord } from "./composerContext";

export function ContextRecordChip({
  record,
  label,
  skills = [],
}: {
  record: ComposerContextRecord | null;
  label?: string;
  skills?: readonly Skill[];
}) {
  if (!record)
    return (
      <ContextChip state="unresolved" title="Context unavailable">
        <ContextChipLabel>{label ?? "Context unavailable"}</ContextChipLabel>
      </ContextChip>
    );
  const kind =
    record.kind === "review-comment" && record.pullRequest
      ? record.pullRequest.state === "open"
        ? record.pullRequest.isDraft
          ? "pr-draft"
          : "pr-open"
        : record.pullRequest.state === "merged"
          ? "pr-merged"
          : "pr-closed"
      : record.kind;
  const text =
    record.kind === "skill"
      ? formatProviderSkillDisplayName(
          skills.find((s) => s.name === record.name) ?? { name: record.name },
        )
      : record.label;
  const title =
    record.kind === "mention"
      ? record.path
      : record.kind === "skill"
        ? `$${record.name}`
        : "text" in record
          ? record.text
          : record.label;
  return (
    <ContextChip
      kind={kind}
      title={title}
      aria-label={text}
      data-composer-context-kind={record.kind}
    >
      {record.kind === "mention" ? (
        <FileEntryIcon path={record.path} />
      ) : record.kind === "skill" ? (
        <SkillChipIcon />
      ) : record.kind === "terminal" ? (
        <TerminalIcon />
      ) : record.kind === "citation" ? (
        <QuoteIcon />
      ) : record.kind === "review-comment" ? (
        record.pullRequest ? (
          <GitPullRequestIcon />
        ) : (
          <MessageSquareIcon />
        )
      ) : (
        <FileIcon />
      )}
      <ContextChipLabel>{text}</ContextChipLabel>
    </ContextChip>
  );
}
