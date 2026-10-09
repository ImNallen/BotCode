import type {
  PullRequestDestination,
  PreparePullRequestInput,
  Thread,
} from "../ipc";
import type { PrAccess } from "../panel/prInbox";
import type { PrObservation } from "../panel/prReview";
import { findingPrompt, type ReviewDraftRequest } from "../panel/reviews";
import {
  acceptsCompletion,
  attachmentIdentity,
  readyAttachments,
  recoveryFit,
  type ComposerInput,
} from "./composerAttachments";
import { importContext } from "./composerContext";
import { composerDraftKey } from "./composerDrafts";

export function sameHandoffSource(
  current: ComposerInput,
  source: ComposerInput,
) {
  return (
    current.scopeKey === source.scopeKey &&
    current.threadId === source.threadId &&
    acceptsCompletion(current, source, true)
  );
}

export class PullRequestPreparation {
  private prepared: Thread | null = null;
  private pending: Promise<Thread> | null = null;
  readonly target: PrObservation;
  readonly request: ReviewDraftRequest | null;
  readonly source: ComposerInput;
  private readonly access: PrAccess | undefined;

  constructor(
    target: PrObservation,
    request: ReviewDraftRequest | null,
    source: ComposerInput,
    access?: PrAccess,
  ) {
    this.target = { ...target };
    this.request = request ? structuredClone(request) : null;
    this.source = source;
    this.access = typeof access === "object" ? { ...access } : access;
  }

  get thread() {
    return this.prepared;
  }

  prepare({
    destination,
    current,
    persist,
    prepare,
  }: {
    destination: PullRequestDestination;
    current: () => ComposerInput;
    persist: (source: ComposerInput) => Promise<void>;
    prepare: (input: PreparePullRequestInput) => Promise<Thread>;
  }): Promise<Thread> {
    if (this.prepared) return Promise.resolve(this.prepared);
    if (this.pending) return this.pending;
    const sourceThreadId = this.source.threadId;
    if (!sourceThreadId)
      return Promise.reject(
        new Error("Open a conversation before checking out a pull request."),
      );
    const run = async () => {
      if (!sameHandoffSource(current(), this.source))
        throw new Error(
          "The conversation changed. Choose the pull request action again.",
        );
      if (!readyAttachments(this.source.attachments))
        throw new Error(
          "Wait for files to finish attaching before preparing the checkout.",
        );
      await persist(this.source);
      if (!sameHandoffSource(current(), this.source))
        throw new Error(
          "The conversation changed. Choose the pull request action again.",
        );
      const thread = await prepare({
        sourceThreadId: this.access ?? sourceThreadId,
        target: this.target,
        destination,
      });
      this.prepared = thread;
      return thread;
    };
    this.pending = run().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
}

export function preparedRepairInput({
  current,
  activation,
  destination,
  request,
}: {
  current: ComposerInput;
  activation: number;
  destination: Pick<Thread, "id" | "workspaceId">;
  request: ReviewDraftRequest;
}): ComposerInput | null {
  if (
    current.threadId !== destination.id ||
    current.scopeKey !==
      composerDraftKey(destination.workspaceId, destination.id) ||
    current.activation !== activation
  )
    return null;
  return {
    ...current,
    text: `${current.text}${current.text ? "\n\n" : ""}${findingPrompt(request)}`,
    generation: current.generation + 1,
  };
}

export async function persistPreparedRepair({
  current,
  activation,
  destination,
  request,
  persist,
}: {
  current: () => ComposerInput;
  activation: number;
  destination: Pick<Thread, "id" | "workspaceId">;
  request: ReviewDraftRequest;
  persist: (input: ComposerInput) => Promise<void>;
}): Promise<
  { kind: "active"; input: ComposerInput } | { kind: "saved" } | null
> {
  for (;;) {
    const source = current();
    const input = preparedRepairInput({
      current: source,
      activation,
      destination,
      request,
    });
    if (!input) return null;
    await persist(input);
    const latest = current();
    if (sameHandoffSource(latest, source)) return { kind: "active", input };
    if (
      latest.activation !== activation ||
      latest.threadId !== destination.id ||
      latest.scopeKey !== source.scopeKey
    )
      return { kind: "saved" };
  }
}

export function carryCheckoutDraft(
  destination: ComposerInput,
  source: ComposerInput,
): ComposerInput {
  const attachments = readyAttachments(source.attachments);
  if (!attachments)
    throw new Error(
      "Wait for files to finish attaching before selecting a worktree.",
    );
  const reason = recoveryFit(
    destination.attachments,
    {
      prompt: source.text,
      attachments,
      context: { version: 1, records: source.records },
    },
    destination.records,
  );
  if (reason) throw new Error(reason);
  const imported = importContext({
    text: source.text,
    records: source.records,
  });
  const identities = new Set(
    destination.attachments.flatMap((slot) =>
      slot.status === "ready" ? [attachmentIdentity(slot.attachment)] : [],
    ),
  );
  return {
    ...destination,
    text: [destination.text, imported.text].filter(Boolean).join("\n\n"),
    records: [...destination.records, ...imported.records],
    attachments: [
      ...destination.attachments,
      ...source.attachments.filter(
        (slot) =>
          slot.status === "ready" &&
          !identities.has(attachmentIdentity(slot.attachment)),
      ),
    ],
    generation: destination.generation + 1,
  };
}
