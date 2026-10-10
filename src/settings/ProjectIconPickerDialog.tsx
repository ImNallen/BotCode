// Ported from pingdotgg/t3code v0.0.45 components/settings/ProjectIconPickerDialog.tsx (MIT).
import { deriveProjectIdentity, ProjectMonogram } from "../ProjectBadge";
import { type ProjectIconColor, type ProjectIconOverride } from "../ipc";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterProjectIconNames,
  firstEmoji,
  PROJECT_EMOJIS,
  PROJECT_ICON_COLORS,
  projectIconColorClassName,
} from "../project/projectIconOptions";
import { cn } from "../lib/cn";
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
import { ScrollArea } from "../ui/scrollArea";
import { Toggle } from "../ui/controls";

const DEFAULT_ICON: IconName = "folder-code";
import { isMonogramText } from "../project/projectIcon";

function iconLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function ProjectIconPickerDialog({
  current,
  projectName,
  open,
  onOpenChange,
  onSelect,
}: {
  readonly current: ProjectIconOverride | null;
  readonly projectName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (icon: ProjectIconOverride) => void;
}) {
  const automatic = deriveProjectIdentity(projectName);
  const [mode, setMode] = useState<ProjectIconOverride["kind"]>(
    current?.kind ?? "lucide",
  );
  const [iconName, setIconName] = useState<IconName>(
    current?.kind === "lucide" ? (current.name as IconName) : DEFAULT_ICON,
  );
  const [color, setColor] = useState<ProjectIconColor>(
    current && current.kind !== "emoji" ? current.color : automatic.color,
  );
  const [letters, setLetters] = useState(
    current?.kind === "monogram" ? current.text : automatic.monogram,
  );
  const [emoji, setEmoji] = useState(
    current?.kind === "emoji" ? current.emoji : "💻",
  );
  const [query, setQuery] = useState("");
  const [customEmoji, setCustomEmoji] = useState("");
  const previousOpenRef = useRef(false);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      setMode(current?.kind ?? "lucide");
      setIconName(
        current?.kind === "lucide" ? (current.name as IconName) : DEFAULT_ICON,
      );
      setColor(
        current && current.kind !== "emoji" ? current.color : automatic.color,
      );
      setLetters(
        current?.kind === "monogram" ? current.text : automatic.monogram,
      );
      setEmoji(current?.kind === "emoji" ? current.emoji : "💻");
      setQuery("");
      setCustomEmoji("");
    }
    previousOpenRef.current = open;
  }, [current, open, automatic.color, automatic.monogram]);

  const icons = useMemo(() => filterProjectIconNames(query), [query]);
  const selectedColorClassName = projectIconColorClassName(color);
  const monogram = letters.normalize("NFKC").trim().toUpperCase();
  const validMonogram = isMonogramText(monogram);
  const save = () => {
    if (mode === "monogram" && !validMonogram) return;
    onSelect(
      mode === "monogram"
        ? { kind: "monogram", text: monogram, color }
        : mode === "lucide"
          ? { kind: "lucide", name: iconName, color }
          : { kind: "emoji", emoji },
    );
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="w-full sm:w-[32rem]"
    >
      <DialogHeader>
        <DialogTitle>Choose project icon</DialogTitle>
        <DialogDescription>
          Choose an icon, emoji, or monogram.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex min-h-0 flex-col">
        <div
          role="group"
          aria-label="Icon type"
          data-slot="toggle-group"
          data-variant="segmented"
          className="flex w-fit *:focus-visible:z-10 *:pointer-coarse:after:min-w-auto gap-0.5 rounded-lg bg-input/40 p-0.5"
        >
          {(
            [
              ["lucide", "Icons"],
              ["emoji", "Emoji"],
              ["monogram", "Monogram"],
            ] as const
          ).map(([value, label]) => (
            <Toggle
              key={value}
              variant="segmented"
              size="segmented"
              pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {label}
            </Toggle>
          ))}
        </div>

        {mode !== "emoji" ? (
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              Color
            </div>
            <div
              className="flex flex-wrap gap-1.5"
              role="group"
              aria-label="Icon color"
            >
              {PROJECT_ICON_COLORS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-label={option.label}
                  aria-pressed={color === option.value}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    color === option.value && "border-foreground/64",
                  )}
                  onClick={() => setColor(option.value)}
                >
                  <span
                    className={cn(
                      "size-4 rounded-full",
                      option.swatchClassName,
                    )}
                  />
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {mode === "lucide" ? (
          <>
            <Input
              type="search"
              value={query}
              aria-label="Search Lucide icons"
              placeholder="Search all Lucide icons"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <ScrollArea scrollFade className="max-h-64">
              <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                {icons.map((name) => (
                  <button
                    key={name}
                    type="button"
                    aria-label={iconLabel(name)}
                    aria-pressed={iconName === name}
                    className={cn(
                      "flex aspect-square items-center justify-center rounded-md border border-transparent outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                      iconName === name && "border-border bg-accent",
                      selectedColorClassName,
                    )}
                    onClick={() => setIconName(name)}
                  >
                    <DynamicIcon name={name} className="size-5" />
                  </button>
                ))}
              </div>
            </ScrollArea>
            {icons.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No icons found.
              </p>
            ) : null}
          </>
        ) : mode === "monogram" ? (
          <div className="flex items-center gap-4 py-2">
            <ProjectMonogram
              text={validMonogram ? monogram : automatic.monogram}
              color={color}
              className="size-12"
            />
            <div className="flex-1 space-y-2">
              <label htmlFor="project-monogram" className="text-sm font-medium">
                Letters
              </label>
              <Input
                id="project-monogram"
                value={letters}
                onChange={(event) => setLetters(event.currentTarget.value)}
                aria-describedby="project-monogram-hint"
                aria-invalid={!validMonogram}
                autoComplete="off"
              />
              <p
                id="project-monogram-hint"
                className="text-xs text-muted-foreground"
              >
                One or two letters or numbers.
              </p>
            </div>
          </div>
        ) : (
          <>
            <ScrollArea scrollFade className="max-h-64">
              <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                {PROJECT_EMOJIS.map((option) => (
                  <button
                    key={option.emoji}
                    type="button"
                    aria-label={option.label}
                    aria-pressed={emoji === option.emoji}
                    className={cn(
                      "flex aspect-square items-center justify-center rounded-md border border-transparent text-xl outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                      emoji === option.emoji && "border-border bg-accent",
                    )}
                    onClick={() => setEmoji(option.emoji)}
                  >
                    {option.emoji}
                  </button>
                ))}
              </div>
            </ScrollArea>
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                Or paste any emoji
              </div>
              <Input
                value={customEmoji}
                aria-label="Custom emoji"
                placeholder="Paste an emoji"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setCustomEmoji(value);
                  const nextEmoji = firstEmoji(value);
                  if (nextEmoji) setEmoji(nextEmoji);
                }}
              />
            </div>
          </>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button onClick={save} disabled={mode === "monogram" && !validMonogram}>
          Save icon
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
