import { WidgetSandbox } from "@/components/widget/WidgetSandbox";
import type { Segment } from "@/lib/chat";

type WidgetSegment = Extract<Segment, { kind: "widget" }>;

const EMPTY_WIDGET_DATA: Record<string, unknown> = {};

export function collectLatestWidgets(segments: Segment[]): WidgetSegment[] {
  const latestById = new Map<string, WidgetSegment>();

  for (const segment of segments) {
    if (segment.kind !== "widget") continue;
    latestById.set(segment.widgetId, segment);
  }

  const seen = new Set<string>();
  const ordered: WidgetSegment[] = [];

  for (const segment of segments) {
    if (segment.kind !== "widget") continue;
    if (seen.has(segment.widgetId)) continue;
    const latest = latestById.get(segment.widgetId);
    if (latest) {
      ordered.push(latest);
      seen.add(segment.widgetId);
    }
  }

  return ordered;
}

export function coalesceWidgetSegments(segments: Segment[]): Segment[] {
  const latestWidgets = new Map(
    collectLatestWidgets(segments).map((segment) => [segment.widgetId, segment] as const),
  );
  const seen = new Set<string>();
  const output: Segment[] = [];

  for (const segment of segments) {
    if (segment.kind !== "widget") {
      output.push(segment);
      continue;
    }
    if (seen.has(segment.widgetId)) continue;
    seen.add(segment.widgetId);
    output.push(latestWidgets.get(segment.widgetId) ?? segment);
  }

  return output;
}

export function WidgetRenderer({ widget }: { widget: WidgetSegment }) {
  return (
    <div className="my-3" role="group" aria-label={widget.title.replace(/_/g, " ")}>
      <WidgetSandbox
        widgetId={widget.widgetId}
        html={widget.html}
        data={widget.data ?? EMPTY_WIDGET_DATA}
        updateMode={widget.updateMode}
      />
    </div>
  );
}
