# Typing indicator
URL: /elements/typing-indicator

The classic three dots, tuned to read as presence rather than noise.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

Three dots bouncing in a staggered wave, either bare or sitting inside a rounded bubble. With a runtime you mount it for the brief window before the first token lands; standalone you show and hide it yourself.

## Getting started

**With a runtime:**

This belongs on screen for exactly one window: a run is active and the newest message has not produced any content yet. Nothing about the dots themselves depends on the runtime; only the decision to render it does.

1. ### Show it before the first token

   ```
   "use client";

   import { useAuiState } from "@assistant-ui/react";
   import { TypingIndicator } from "@/components/assistant-ui/elements/typing-indicator";

   function AssistantTyping() {
     const waiting = useAuiState((s) => {
       if (!s.thread.isRunning) return false;
       const last = s.thread.messages.at(-1);
       return last?.role === "assistant" && last.parts.length === 0;
     });
     if (!waiting) return null;
     return <TypingIndicator />;
   }
   ```

2. ### Place it where the reply will render

   Render `AssistantTyping` in the same spot the assistant's message body will take over once content starts arriving, so nothing shifts when it disappears.

**Standalone (no runtime):**

Standalone, `TypingIndicator` takes no data at all; mounting and unmounting it is entirely up to you.

1. ### Drop it in while you wait

   ```
   "use client";

   import { useState } from "react";
   import { TypingIndicator } from "@/components/assistant-ui/elements/typing-indicator";

   export function Chat() {
     const [waiting, setWaiting] = useState(false);
     return waiting ? <TypingIndicator /> : null;
   }
   ```

2. ### Choose a variant

   ```
   <TypingIndicator variant="bare" />
   ```

## Examples

### Bare dots without the bubble

`variant="bare"` drops the rounded `paper` surface and renders only the three dots, for placement inside your own container.

```
<TypingIndicator variant="bare" className="gap-0.5" />
```

### Restyle the dots

The bubble variant wraps the dots in the shared `paper` surface from `surfaces.tsx`; `className` on either variant only affects the outermost element (the bubble itself for `"bubble"`, the dot row for `"bare"`). The dots' color, size, and bounce timing are fixed and not exposed as props.

```
<TypingIndicator className="px-3 py-2.5" />
```

## API reference

**With a runtime:**

### Thread state

| Selector             | Type                      | Description                                                                                                          |
| -------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `s.thread.isRunning` | `boolean`                 | Whether a run is active.                                                                                             |
| `s.thread.messages`  | `readonly MessageState[]` | `.at(-1)` is the newest message; an assistant message with an empty `parts` array means nothing has streamed in yet. |

**Standalone (no runtime):**

### TypingIndicator

| Prop        | Type                 | Default    | Description                                                                     |
| ----------- | -------------------- | ---------- | ------------------------------------------------------------------------------- |
| `variant`   | `"bubble" \| "bare"` | `"bubble"` | `"bubble"` wraps the dots in a rounded surface; `"bare"` renders only the dots. |
| `className` | `string`             |            | Merged onto the root.                                                           |

`role` and `aria-label` are fixed by the component (`"status"` and `"Assistant is typing"`) and are not part of the prop type; every other `div` prop except `children` and `variant` is forwarded.