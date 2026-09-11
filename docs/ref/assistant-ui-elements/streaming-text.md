# Streaming text
URL: /elements/streaming-text

Tokens arrive softly: the newest words land in blue and settle into ink.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

Word by word text with the newest handful tinted blue and a caret at the end while it streams; older words fade back to plain text over the next few hundred milliseconds. With a runtime you feed it a part's growing text and its running status; standalone you hold the segments and a reveal count yourself.

## Getting started

**With a runtime:**

`MessagePrimitive.Parts` hands a custom part renderer the part's own fields as props, `text` and `status` included, so there is no selector to write at all: `count` just tracks how many words that string currently has.

1. ### Register it as a part renderer

   ```
   "use client";

   import { useMemo } from "react";
   import type { TextMessagePartComponent } from "@assistant-ui/react";
   import { StreamingText, type Segment } from "@/components/assistant-ui/elements/streaming-text";

   const StreamingTextPart: TextMessagePartComponent = ({ text, status }) => {
     const segments = useMemo<Segment[]>(() => [{ text }], [text]);
     const count = useMemo(() => text.split(" ").length, [text]);
     return <StreamingText segments={segments} count={count} streaming={status.type === "running"} />;
   };
   ```

   `TextMessagePartComponent` is the same component type `MessagePrimitive.Parts` expects for its `Text` slot, so no wrapper or adapter is needed between the two.

2. ### Plug it into the parts list

   ```
   import { MessagePrimitive } from "@assistant-ui/react";

   <MessagePrimitive.Parts components={{ Text: StreamingTextPart, Reasoning: StreamingTextPart }} />
   ```

   The same component works for both slots: a `ReasoningMessagePartComponent` carries the same `text` and `status` fields. Once a part's `status.type` moves to `"complete"`, the caret disappears and the last words settle to plain text on their own.

**Standalone (no runtime):**

Standalone, you decide both what the segments say and how many words are currently revealed; the element only handles the fade and the coloring.

1. ### Hold segments and a reveal count

   ```
   "use client";

   import { useState } from "react";
   import { StreamingText, type Segment } from "@/components/assistant-ui/elements/streaming-text";

   const SEGMENTS: Segment[] = [
     { text: "The response streams in as" },
     { text: "useAuiState", mono: true },
     { text: "resolves each part." },
   ];

   export function Answer() {
     const [count, setCount] = useState(0);
     return <StreamingText segments={SEGMENTS} count={count} streaming={count < 12} />;
   }
   ```

   `mono: true` on a segment renders that run of words in a code-styled span; it applies to every word inside that segment.

2. ### Advance the count yourself

   ```
   useEffect(() => {
     const id = setInterval(() => setCount((c) => Math.min(c + 1, 12)), 90);
     return () => clearInterval(id);
   }, []);
   ```

   Nothing advances `count` on its own; an out-of-range value clamps rather than throwing, so it is safe to overshoot.

## Anatomy

```
<p data-slot="streaming-text">
  {/* revealed words, newest two tinted while streaming */}
  <span aria-hidden />{/* caret, only while streaming and at least one word is shown */}
</p>
```

Every segment's text is split on spaces and rejoined into words separated by a single space each: a segment's own line breaks or repeated spaces do not survive into the rendered output. `count` clamps between 0 and the total word count (a negative or `NaN` count shows nothing, an overly large one shows everything). While `streaming` is `true`, the last two words currently shown render tinted; every earlier word is plain text, and a word already past that trailing window transitions back to plain over 700ms rather than snapping. The trailing caret only renders when `streaming` is `true` and at least one word is shown.

## Examples

### Marking a span as code

```
const segments: Segment[] = [
  { text: "Read the value from" },
  { text: "response.data", mono: true },
  { text: "before formatting it." },
];
```

### Restyle the text

Both lanes take `className` on the root, which starts as `min-h-[8.5rem] max-w-sm text-sm leading-relaxed`. The tint and the caret are both fixed to `text-blue-500`/`bg-blue-500`; there is no prop for either color.

```
<StreamingText className="max-w-none text-base" /* ... */ />
```

## API reference

**With a runtime:**

### Part renderer props

| Prop     | Type                | Description                                         |
| -------- | ------------------- | --------------------------------------------------- |
| `text`   | `string`            | The part's string streamed so far.                  |
| `status` | `MessagePartStatus` | `status.type === "running"` until the part settles. |

These arrive on any component registered under `MessagePrimitive.Parts`'s `Text` or `Reasoning` slot; both `TextMessagePartComponent` and `ReasoningMessagePartComponent` carry them.

**Standalone (no runtime):**

### StreamingText

| Prop        | Type        | Default  | Description                                                                                  |
| ----------- | ----------- | -------- | -------------------------------------------------------------------------------------------- |
| `segments`  | `Segment[]` | required | `{ text: string; mono?: boolean }[]`, split on spaces and concatenated into one word stream. |
| `count`     | `number`    | required | Words to reveal, clamped between 0 and the total word count.                                 |
| `streaming` | `boolean`   | required | Tints the newest two shown words and renders a trailing caret.                               |
| `className` | `string`    |          | Merged onto the root.                                                                        |

All other `p` props except `children`, `segments`, `count`, and `streaming` are forwarded to the root.