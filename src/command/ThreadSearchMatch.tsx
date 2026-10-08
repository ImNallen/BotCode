// Ported from pingdotgg/t3code v0.0.45 components/ThreadSearchMatch.tsx (MIT).
import { highlightSearchText } from "./commandPaletteSearch";
function HighlightedSearchText(props: { text: string; query: string }) {
  const parts = highlightSearchText(props.text, props.query);
  return parts.map((part) =>
    part.highlighted ? (
      <mark
        className="bg-transparent font-semibold text-foreground"
        key={part.start}
      >
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

export function ThreadSearchMatchExcerpt(props: {
  match: {
    readonly source: "user" | "assistant";
    readonly snippet: string;
    readonly query: string;
  };
}) {
  const isUser = props.match.source === "user";
  return (
    <span className="truncate text-xs text-muted-foreground/85">
      <span
        className={isUser ? "text-info-foreground" : "text-success-foreground"}
      >
        {isUser ? "You:" : "Agent:"}
      </span>{" "}
      <HighlightedSearchText
        text={props.match.snippet}
        query={props.match.query}
      />
    </span>
  );
}
