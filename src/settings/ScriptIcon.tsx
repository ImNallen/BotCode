// Ported from pingdotgg/t3code v0.0.45 components/projectScriptEditor.tsx (MIT).
import {
  BugIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  WrenchIcon,
} from "lucide-react";
import type { ProjectScript } from "../ipc";
export const SCRIPT_ICONS: Array<{ id: ProjectScript["icon"]; label: string }> =
  [
    { id: "play", label: "Play" },
    { id: "test", label: "Test" },
    { id: "lint", label: "Lint" },
    { id: "configure", label: "Configure" },
    { id: "build", label: "Build" },
    { id: "debug", label: "Debug" },
  ];

export function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScript["icon"];
  className?: string;
}) {
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  return <PlayIcon className={className} />;
}
