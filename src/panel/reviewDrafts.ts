import { z } from "zod";
import { prOperation, prChangeResult } from "./prReview";
import type {
  DraftComment,
  PrObservation,
  PrReviewChange,
  PrChangeResult,
  ReviewVerdict,
} from "./prReview";
export type DraftEntry = { body: string; revision: number };
export type ReviewDraft = {
  verdict?: ReviewVerdict;
  summary: DraftEntry;
  comments: DraftComment[];
  operation: { input: PrReviewChange; result: PrChangeResult | null } | null;
};
export const draftKey = (target: PrObservation) =>
  JSON.stringify([target.key, target.viewer, target.headOid]);
const empty: ReviewDraft = {
  summary: { body: "", revision: 0 },
  comments: [],
  operation: null,
};
export class ReviewDrafts {
  private revision = 0;
  snapshot = () => this.revision;
  private values = new Map<string, ReviewDraft>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get = (key: string) => this.values.get(key) ?? empty;
  private put(key: string, draft: ReviewDraft) {
    this.values.set(key, draft);
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
  verdict(key: string, verdict: ReviewVerdict) {
    this.put(key, { ...this.get(key), verdict });
  }
  summary(key: string, body: string) {
    const draft = this.get(key);
    this.put(key, {
      ...draft,
      summary: { body, revision: draft.summary.revision + 1 },
    });
  }
  add(key: string, comment: Omit<DraftComment, "id" | "revision" | "body">) {
    const draft = this.get(key);
    const id = crypto.randomUUID();
    this.put(key, {
      ...draft,
      comments: [...draft.comments, { ...comment, id, revision: 0, body: "" }],
    });
    return id;
  }
  edit(key: string, id: string, body: string) {
    const draft = this.get(key);
    this.put(key, {
      ...draft,
      comments: draft.comments.map((c) =>
        c.id === id ? { ...c, body, revision: c.revision + 1 } : c,
      ),
    });
  }
  clearComments(key: string) {
    const draft = this.get(key);
    if (draft.operation && !draft.operation.result) return;
    this.put(key, { ...draft, comments: [] });
  }
  remove(key: string, id: string) {
    const draft = this.get(key);
    this.put(key, {
      ...draft,
      comments: draft.comments.filter((c) => c.id !== id),
    });
  }
  start(key: string, input: PrReviewChange) {
    const draft = this.get(key);
    this.put(key, { ...draft, operation: { input, result: null } });
    return draft;
  }
  finish(key: string, captured: ReviewDraft, result: PrChangeResult) {
    const draft = this.get(key);
    this.put(key, {
      ...draft,
      summary:
        result.kind === "applied" &&
        draft.summary.revision === captured.summary.revision
          ? { body: "", revision: draft.summary.revision + 1 }
          : draft.summary,
      comments:
        result.kind === "applied"
          ? draft.comments.filter(
              (c) =>
                !captured.comments.some(
                  (old) => old.id === c.id && old.revision === c.revision,
                ),
            )
          : draft.comments,
      operation: draft.operation ? { ...draft.operation, result } : null,
    });
  }
  acknowledge(key: string) {
    const draft = this.get(key);
    this.put(key, { ...draft, operation: null });
  }
  older(target: PrObservation) {
    const key = draftKey(target);
    return [...this.values.entries()].filter(
      ([other, draft]) =>
        other !== key &&
        other.startsWith(`[${JSON.stringify(target.key)},`) &&
        (draft.summary.body ||
          draft.comments.length ||
          draft.operation?.result?.kind === "uncertain"),
    );
  }
  discard(key: string) {
    this.values.delete(key);
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}
export const reviewDrafts = new ReviewDrafts();

type ConversationDraft = {
  persistenceError?: string;
  body: string;
  revision: number;
  operation: { input: PrReviewChange; result: PrChangeResult | null } | null;
};
const emptyConversation: ConversationDraft = {
  body: "",
  revision: 0,
  operation: null,
};
const storedConversation = z.tuple([
  z.string().max(2048),
  z.object({
    body: z.string(),
    revision: z.number().int().nonnegative(),
    operation: z
      .object({
        input: prOperation.shape.input,
        result: prChangeResult.nullable(),
      })
      .nullable(),
  }),
]);
export class ConversationDrafts {
  private persistenceKey?: string;
  constructor(persistenceKey?: string) {
    this.persistenceKey = persistenceKey;
    if (!persistenceKey) return;
    try {
      const records: unknown = JSON.parse(
        localStorage.getItem(persistenceKey) ?? "[]",
      );
      if (!Array.isArray(records)) return;
      for (const record of records) {
        const parsed = storedConversation.safeParse(record);
        if (!parsed.success) continue;
        const [key, value] = parsed.data;
        if (value.operation && !value.operation.result)
          value.operation.result = {
            kind: "uncertain",
            message:
              "The app restarted while the comment outcome was unknown. Check GitHub before submitting again.",
          };
        this.values.set(key, value);
      }
    } catch {}
  }
  private values = new Map<string, ConversationDraft>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get = (key: string) => this.values.get(key) ?? emptyConversation;
  private put(key: string, value: ConversationDraft) {
    this.values.set(key, value);
    if (this.persistenceKey)
      try {
        localStorage.setItem(
          this.persistenceKey,
          JSON.stringify(
            [...this.values].filter(
              ([, draft]) =>
                draft.body ||
                (draft.operation &&
                  (!draft.operation.result ||
                    draft.operation.result.kind === "uncertain")),
            ),
          ),
        );
        this.values.set(key, { ...value, persistenceError: undefined });
      } catch {
        this.values.set(key, {
          ...value,
          persistenceError:
            "This draft and its submission status could not be saved on this device. Keep this app open and check GitHub before restarting.",
        });
      }
    for (const listener of this.listeners) listener();
  }
  edit(key: string, body: string) {
    const draft = this.get(key);
    this.put(key, { ...draft, body, revision: draft.revision + 1 });
  }
  start(key: string, input: PrReviewChange) {
    const draft = this.get(key);
    this.put(key, { ...draft, operation: { input, result: null } });
    return draft.revision;
  }
  finish(key: string, revision: number, result: PrChangeResult) {
    const draft = this.get(key);
    const clear =
      result.kind === "applied" &&
      draft.revision === revision &&
      (draft.operation?.input.action.kind === "reply" ||
        draft.operation?.input.action.kind === "add_comment");
    this.put(key, {
      ...draft,
      body: clear ? "" : draft.body,
      revision: clear ? draft.revision + 1 : draft.revision,
      operation: draft.operation ? { ...draft.operation, result } : null,
    });
  }
  acknowledge(key: string) {
    this.put(key, { ...this.get(key), operation: null });
  }
}
export const conversationDrafts = new ConversationDrafts();

export const commentDrafts = new ConversationDrafts(
  "bot.pullRequestCommentDrafts",
);
