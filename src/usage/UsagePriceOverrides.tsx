// Ports pingdotgg/t3code v0.0.45 components/usage/UsagePriceOverrides.tsx (MIT) for one environment.
import { useQueryClient } from "@tanstack/react-query";
import { PlusIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "../lib/cn";
import { usePreferences } from "../settings/preferences";
import { Button } from "../ui/controls";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { Tooltip } from "../ui/tooltip";
import {
  applyUsagePriceChanges,
  isEmptyUsagePriceDraft,
  USAGE_PRICE_FIELDS,
  usagePriceCell,
  usagePriceTableChanges,
  type UsagePriceDraft,
  type UsagePriceField,
} from "./prices";

export function UsagePriceOverrides({
  usageModels,
  onOpenChange,
}: {
  readonly usageModels: readonly string[];
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { preferences, save: savePreferences } = usePreferences();
  const prices = preferences.usagePriceOverrides;
  const client = useQueryClient();
  const [drafts, setDrafts] = useState<readonly UsagePriceDraft[]>([]);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const focusRowRef = useRef<string | null>(null);
  const nextRowId = useRef(0);
  const customModels = Object.keys(prices).sort();
  const saving = pending || failed;
  const newModels = new Set(
    drafts.filter((draft) => draft.isNew).map((draft) => draft.model.trim()),
  );
  const rows: readonly UsagePriceDraft[] = [
    ...customModels
      .filter((model) => !saving || !newModels.has(model))
      .map(
        (model) =>
          drafts.find((draft) => draft.id === `model:${model}`) ?? {
            id: `model:${model}`,
            model,
            isNew: false,
            values: {},
          },
      ),
    ...drafts.filter((draft) => draft.isNew),
  ];
  const stagedDrafts = drafts.filter((draft) => !isEmptyUsagePriceDraft(draft));
  const errors = usagePriceTableChanges(prices, stagedDrafts).errors;
  for (const draft of stagedDrafts) {
    if (!draft.isNew) continue;
    if (draft.model.trim() === "") errors.set(draft.id, "Enter a model ID.");
    else if (
      !saving &&
      (customModels.includes(draft.model.trim()) ||
        drafts.some(
          (other) =>
            other.id !== draft.id && other.model.trim() === draft.model.trim(),
        ))
    )
      errors.set(
        draft.id,
        "This model already has a row. Edit its prices there.",
      );
  }
  const hasChanges = stagedDrafts.length > 0;
  const discard = () => {
    setDrafts([]);
    setFailed(false);
  };
  const updateDraft = (draft: UsagePriceDraft) =>
    setDrafts((previous) =>
      previous.some((entry) => entry.id === draft.id)
        ? previous.map((entry) => (entry.id === draft.id ? draft : entry))
        : [...previous, draft],
    );
  const editCell = (
    row: UsagePriceDraft,
    field: UsagePriceField,
    value: string,
  ) => {
    const values = { ...row.values, [field]: value };
    if (!row.isNew && value === usagePriceCell(prices, row.model, field).value)
      delete values[field];
    if (!row.isNew && Object.keys(values).length === 0)
      setDrafts((previous) => previous.filter((entry) => entry.id !== row.id));
    else updateDraft({ ...row, values });
  };
  const save = async () => {
    if (pending || stagedDrafts.length === 0) return;
    const { changes } = usagePriceTableChanges(prices, stagedDrafts);
    setPending(true);
    try {
      await savePreferences({
        usagePriceOverrides: applyUsagePriceChanges(prices, changes),
      });
      setDrafts([]);
      setFailed(false);
      void client.invalidateQueries({ queryKey: ["usage-history"] });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!pending) onOpenChange(open);
      }}
      className="max-w-3xl"
    >
      <DialogHeader>
        <DialogTitle>Custom model prices</DialogTitle>
        <DialogDescription>
          Prices apply to all past and future usage on this device.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-muted-foreground">
            USD / million tokens
          </span>
        </div>
        <div className="min-w-0 overflow-hidden rounded-lg border border-border">
          <Table
            className="min-w-160 table-fixed"
            aria-label="Custom model prices"
          >
            <colgroup>
              <col className="w-[34%]" />
              {USAGE_PRICE_FIELDS.map((field) => (
                <col key={field.key} />
              ))}
              <col className="w-10" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>Model ID</TableHead>
                {USAGE_PRICE_FIELDS.map((field) => (
                  <TableHead key={field.key}>{field.label}</TableHead>
                ))}
                <TableHead>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Add model price"
                    disabled={saving}
                    onClick={() => {
                      const id = `new:${nextRowId.current++}`;
                      focusRowRef.current = id;
                      updateDraft({ id, model: "", isNew: true, values: {} });
                    }}
                  >
                    <PlusIcon aria-hidden />
                  </Button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center whitespace-normal"
                  >
                    <p className="py-6 text-muted-foreground">
                      No custom prices. Add a row to override automatic pricing.
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.id} data-row-id={row.id}>
                    <TableCell className="whitespace-normal">
                      {row.isNew ? (
                        <Input
                          size="compact"
                          value={row.model}
                          ref={(node) => {
                            if (node && focusRowRef.current === row.id) {
                              node.focus();
                              focusRowRef.current = null;
                            }
                          }}
                          aria-label="New model ID"
                          aria-invalid={
                            (row.model.trim() !== "" && errors.has(row.id)) ||
                            undefined
                          }
                          list="usage-price-models"
                          placeholder="Model ID"
                          autoComplete="off"
                          spellCheck={false}
                          disabled={saving}
                          onChange={(event) =>
                            updateDraft({ ...row, model: event.target.value })
                          }
                        />
                      ) : (
                        <span
                          className={cn(
                            "block break-all",
                            row.removed && "text-muted-foreground line-through",
                          )}
                        >
                          {row.model}
                        </span>
                      )}
                      {errors.has(row.id) &&
                      (row.model.trim() !== "" ||
                        Object.values(row.values).some(
                          (value) => value !== "",
                        )) ? (
                        <p
                          role="alert"
                          className="mt-1 text-xs text-destructive"
                        >
                          {errors.get(row.id)}
                        </p>
                      ) : null}
                    </TableCell>
                    {row.removed ? (
                      <TableCell colSpan={4}>
                        <span className="text-muted-foreground">
                          Automatic pricing after saving
                        </span>
                      </TableCell>
                    ) : (
                      USAGE_PRICE_FIELDS.map((field) => {
                        const cell = usagePriceCell(
                          prices,
                          row.model,
                          field.key,
                        );
                        return (
                          <TableCell key={field.key}>
                            <Input
                              size="compact"
                              inputMode="decimal"
                              aria-label={`${field.label} price for ${row.model || "new model"}`}
                              value={
                                row.values[field.key] ??
                                (row.isNew ? "" : cell.value)
                              }
                              placeholder={
                                row.isNew
                                  ? field.optional
                                    ? "Input rate"
                                    : "0.00"
                                  : cell.placeholder
                              }
                              autoComplete="off"
                              disabled={saving}
                              font="mono"
                              onChange={(event) =>
                                editCell(row, field.key, event.target.value)
                              }
                            />
                          </TableCell>
                        );
                      })
                    )}
                    <TableCell>
                      <Tooltip
                        content={
                          row.removed
                            ? "Undo reset"
                            : row.isNew
                              ? "Remove row"
                              : "Reset to automatic"
                        }
                      >
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          disabled={saving}
                          aria-label={
                            row.removed
                              ? `Undo reset for ${row.model}`
                              : row.isNew
                                ? "Remove new model"
                                : `Reset price for ${row.model} to automatic`
                          }
                          onClick={() => {
                            if (row.isNew)
                              setDrafts((previous) =>
                                previous.filter((entry) => entry.id !== row.id),
                              );
                            else if (row.removed) {
                              if (Object.keys(row.values).length === 0)
                                setDrafts((previous) =>
                                  previous.filter(
                                    (entry) => entry.id !== row.id,
                                  ),
                                );
                              else updateDraft({ ...row, removed: false });
                            } else updateDraft({ ...row, removed: true });
                          }}
                        >
                          {row.isNew ? (
                            <XIcon aria-hidden />
                          ) : (
                            <RotateCcwIcon aria-hidden />
                          )}
                        </Button>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <datalist id="usage-price-models">
          {[...new Set(usageModels)]
            .filter((model) => !customModels.includes(model))
            .sort()
            .map((model) => (
              <option key={model} value={model} />
            ))}
        </datalist>
        <p className="text-xs text-muted-foreground">
          Blank cache rates use the input price. Enter 0 for free tokens.
        </p>
        {failed ? (
          <p role="status" className="text-xs text-destructive">
            Not saved · Could not save. Try again.
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter variant="bare" className="items-center">
        <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
          {hasChanges ? (
            <Button variant="ghost" disabled={pending} onClick={discard}>
              {failed ? "Discard pending changes" : "Discard changes"}
            </Button>
          ) : null}
          <Button
            disabled={pending || !hasChanges || (!failed && errors.size > 0)}
            onClick={() => void save()}
          >
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </DialogFooter>
    </Dialog>
  );
}
