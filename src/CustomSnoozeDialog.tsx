// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/CustomSnoozeDialog.tsx (MIT).
import { CalendarIcon, ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "./lib/cn";
import {
  localSnoozeDate,
  localSnoozeTime,
  parseLocalSnoozeDate,
  resolveCustomSnooze,
  snoozeCalendarDisabled,
  snoozeDateLabel,
  type CustomSnoozeInput,
} from "./lib/snooze";
import { weekStartsOn } from "./lib/weekStart";
import { Calendar } from "./ui/calendar";
import { Button, Toggle, selectItem, selectTrigger } from "./ui/controls";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Menu, MenuItem } from "./ui/menu";
import { Popover } from "./ui/popover";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "./ui/number-field";

type Unit = Extract<CustomSnoozeInput, { mode: "duration" }>["unit"];
const UNIT_LABELS: Record<Unit, string> = {
  minutes: "Minutes",
  hours: "Hours",
  days: "Days",
};

export function CustomSnoozeDialog({
  onCancel,
  onSnooze,
}: {
  onCancel: () => void;
  onSnooze: (untilMs: number) => void;
}) {
  const id = useId();
  const [initial] = useState(() => new Date(Date.now() + 3_600_000));
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(localSnoozeDate(initial));
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [time, setTime] = useState(localSnoozeTime(initial));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<Unit>("hours");
  const [error, setError] = useState<string | null>(null);
  const input: CustomSnoozeInput =
    mode === "date" ? { mode, date, time } : { mode, amount, unit };
  const step = (delta: number) => {
    setAmount(String(Math.max(0, (Number(amount) || 0) + delta)));
    setError(null);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      className="sm:max-w-sm"
    >
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          const result = resolveCustomSnooze(input, new Date());
          if (result.ok) onSnooze(result.untilMs);
          else setError(result.error);
        }}
      >
        <DialogHeader>
          <DialogTitle>Custom snooze</DialogTitle>
          <DialogDescription>
            Choose when snoozed threads return to your inbox.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div
              role="group"
              aria-label="Schedule type"
              data-slot="toggle-group"
              data-variant="segmented"
              className="flex w-full *:flex-1 *:focus-visible:z-10 dark:*:[[data-slot=separator]:has(+[data-slot=toggle]:hover)]:before:bg-input/64 dark:*:[[data-slot=separator]:has(+[data-slot=toggle][data-pressed])]:before:bg-input dark:*:[[data-slot=toggle]:hover+[data-slot=separator]]:before:bg-input/64 dark:*:[[data-slot=toggle][data-pressed]+[data-slot=separator]]:before:bg-input *:pointer-coarse:after:min-w-auto gap-0.5 rounded-lg bg-input/40 p-0.5"
            >
              {(
                [
                  ["date", "Date and time"],
                  ["duration", "Duration"],
                ] as const
              ).map(([value, label]) => (
                <Toggle
                  key={value}
                  variant="segmented"
                  size="segmented"
                  pressed={mode === value}
                  onClick={() => {
                    setMode(value);
                    setError(null);
                  }}
                >
                  {label}
                </Toggle>
              ))}
            </div>
            <div className="flex flex-col gap-4">
              {mode === "date" ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={`${id}-date`}>Date</Label>
                    <Popover
                      open={calendarOpen}
                      onOpenChange={setCalendarOpen}
                      align="start"
                      aria-label="Choose snooze date"
                      trigger={(props) => (
                        <Button
                          {...props}
                          id={`${id}-date`}
                          variant="outline"
                          className="w-full justify-between"
                        >
                          {snoozeDateLabel(date)}
                          <CalendarIcon className="size-4 text-muted-foreground" />
                        </Button>
                      )}
                    >
                      <Calendar
                        mode="single"
                        required
                        selected={parseLocalSnoozeDate(date)}
                        defaultMonth={parseLocalSnoozeDate(date)}
                        {...(weekStartsOn === undefined
                          ? {}
                          : { weekStartsOn })}
                        disabled={snoozeCalendarDisabled(new Date())}
                        onSelect={(selected) => {
                          setDate(localSnoozeDate(selected));
                          setCalendarOpen(false);
                          setError(null);
                        }}
                      />
                    </Popover>
                  </div>
                  <Label
                    className="flex min-w-0 flex-col items-stretch"
                    htmlFor={`${id}-time`}
                  >
                    Time
                    <Input
                      id={`${id}-time`}
                      className="h-9 sm:h-8"
                      type="time"
                      required
                      value={time}
                      onChange={(event) => {
                        setTime(event.target.value);
                        setError(null);
                      }}
                    />
                  </Label>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <NumberField>
                    <Label htmlFor={`${id}-amount`}>Snooze for</Label>
                    <NumberFieldGroup>
                      <NumberFieldDecrement
                        aria-label="Decrease duration"
                        onClick={() => step(-1)}
                      />
                      <NumberFieldInput
                        id={`${id}-amount`}
                        required
                        value={amount}
                        onChange={(event) => {
                          setAmount(event.target.value);
                          setError(null);
                        }}
                      />
                      <NumberFieldIncrement
                        aria-label="Increase duration"
                        onClick={() => step(1)}
                      />
                    </NumberFieldGroup>
                  </NumberField>
                  <Label
                    className="flex min-w-0 flex-col items-stretch"
                    htmlFor={`${id}-unit`}
                  >
                    Unit
                    <Menu
                      trigger={(props) => (
                        <button
                          type="button"
                          {...props}
                          id={`${id}-unit`}
                          className={cn(selectTrigger(), "min-w-0")}
                        >
                          <span className="flex-1 truncate">
                            {UNIT_LABELS[unit]}
                          </span>
                          <ChevronDownIcon className="-me-1 size-3 opacity-50" />
                        </button>
                      )}
                    >
                      {(Object.keys(UNIT_LABELS) as Unit[]).map((value) => (
                        <MenuItem
                          key={value}
                          role="menuitemradio"
                          aria-checked={unit === value}
                          className={selectItem}
                          onClick={() => {
                            setUnit(value);
                            setError(null);
                          }}
                        >
                          {UNIT_LABELS[value]}
                        </MenuItem>
                      ))}
                    </Menu>
                  </Label>
                </div>
              )}
            </div>
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit">Snooze</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
