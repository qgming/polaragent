# Empty state
URL: /elements/empty-state

The first screen: a greeting, three ways in, and the composer front and center.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

An empty state is the first screen a thread shows: nothing sent yet, a greeting, a few ways in, and the composer already visible. With a runtime it appears and disappears with the thread's own emptiness; standalone you control when it shows and what it offers.

## Getting started

**With a runtime:**

An assistant-ui thread starts empty until the first message lands, and `s.thread.isEmpty` tracks exactly that.

1. ### Show it while the thread is empty

   ```
   "use client";

   import { AuiIf } from "@assistant-ui/react";
   import { EmptyState, EmptyStateGreeting } from "./empty-state";

   function Welcome() {
     return (
       <AuiIf condition={(s) => s.thread.isEmpty}>
         <EmptyState>
           <EmptyStateGreeting>How can I help?</EmptyStateGreeting>
           {/* suggestions, composer */}
         </EmptyState>
       </AuiIf>
     );
   }
   ```

   `isEmpty` stays `false` while the thread is still loading its history, so a persisted conversation never flashes the greeting first.

2. ### Turn suggestions into real prompts

   ```
   import { useAuiState, ThreadPrimitive } from "@assistant-ui/react";
   import { EmptyStateSuggestions, EmptyStateSuggestion } from "./empty-state";

   function Suggestions() {
     const suggestions = useAuiState((s) => s.thread.suggestions);
     return (
       <EmptyStateSuggestions>
         {suggestions.map((suggestion, index) => (
           <ThreadPrimitive.Suggestion key={suggestion.prompt} prompt={suggestion.prompt} asChild>
             <EmptyStateSuggestion index={index}>
               {suggestion.title ?? suggestion.prompt}
             </EmptyStateSuggestion>
           </ThreadPrimitive.Suggestion>
         ))}
       </EmptyStateSuggestions>
     );
   }
   ```

   `ThreadPrimitive.Suggestion` fills the composer with `prompt` by default, so the reader can edit it before sending; pass `send` to submit it immediately on click instead. `s.thread.suggestions` is whatever your app configures on the runtime, static onboarding prompts or ones the model proposed on an earlier turn.

**Standalone (no runtime):**

Standalone, the whole screen is yours: greeting text, the suggestion list, and what pressing one does.

1. ### List a few starting points

   ```
   "use client";

   import {
     EmptyState,
     EmptyStateGreeting,
     EmptyStateSuggestions,
     EmptyStateSuggestion,
     EmptyStateComposer,
   } from "@/components/assistant-ui/elements/empty-state";

   const STARTERS = ["Summarize this doc", "Draft a reply", "Explain this error"];

   export function Welcome({ onPick }: { onPick: (prompt: string) => void }) {
     return (
       <EmptyState>
         <EmptyStateGreeting>How can I help?</EmptyStateGreeting>
         <EmptyStateSuggestions>
           {STARTERS.map((prompt, index) => (
             <EmptyStateSuggestion key={prompt} index={index} onClick={() => onPick(prompt)}>
               {prompt}
             </EmptyStateSuggestion>
           ))}
         </EmptyStateSuggestions>
         <EmptyStateComposer placeholder="Ask anything" onSend={() => onPick("")} />
       </EmptyState>
     );
   }
   ```

2. ### Stagger the entrance

   Each suggestion animates in on mount with a delay derived from `index`; pass the item's position in the array so the row cascades instead of popping in together:

   ```
   {STARTERS.map((prompt, index) => (
     <EmptyStateSuggestion key={prompt} index={index}>
       {prompt}
     </EmptyStateSuggestion>
   ))}
   ```

## Anatomy

```
<div data-slot="empty-state">
  <h2 data-slot="empty-state-greeting" />
  <div data-slot="empty-state-suggestions">
    <button data-slot="empty-state-suggestion" />
  </div>
  <div data-slot="empty-state-composer">
    <span>{/* placeholder text */}</span>
    <button aria-label="Send" />
  </div>
</div>
```

The greeting, the suggestion row, and the composer each fade and slide in on mount at increasing delays, the composer last, at 360ms, so the screen builds top to bottom instead of appearing all at once. `EmptyStateComposer` is the same shell as `ChatPanelComposer`: `placeholder` is displayed text, not a bound value, and the send button disables itself whenever `onSend` is left `undefined`.

## Examples

### Restyle the layout

`EmptyState` only sets a max width and a vertical gap; every part accepts `className`, so the row of suggestions can wrap to a grid or the greeting can drop the animation:

```
<EmptyState className="max-w-lg gap-4">
  <EmptyStateGreeting className="animate-none text-3xl">
    How can I help?
  </EmptyStateGreeting>
  {/* ... */}
</EmptyState>
```

### Suggestion delay

**With a runtime:**

The stagger comes entirely from the `index` you pass; a filtered or reordered list re-derives it from the array position, not from a stored value:

```
{suggestions.map((suggestion, index) => (
  <ThreadPrimitive.Suggestion key={suggestion.prompt} prompt={suggestion.prompt} asChild>
    <EmptyStateSuggestion index={index}>{suggestion.prompt}</EmptyStateSuggestion>
  </ThreadPrimitive.Suggestion>
))}
```

**Standalone (no runtime):**

Standalone, the same rule applies: `index` is read once per render to compute the delay, so keep it stable across re-renders of the same list.

## API reference

**With a runtime:**

### Primitive parts

| Part                         | Renders  | Notes                                                                                                          |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `AuiIf`                      | children | Renders `children` while `condition` selects `true`; use `(s) => s.thread.isEmpty`.                            |
| `ThreadPrimitive.Suggestion` | `button` | Fills the composer with `prompt` on click by default; pass `send` to submit it immediately. Accepts `asChild`. |

### Thread state

| Selector               | Type                          | Description                                                       |
| ---------------------- | ----------------------------- | ----------------------------------------------------------------- |
| `s.thread.isEmpty`     | `boolean`                     | `true` when the thread has no messages and isn't loading history. |
| `s.thread.suggestions` | `readonly ThreadSuggestion[]` | `{ title?, label?, prompt }` entries configured on the runtime.   |

**Standalone (no runtime):**

### EmptyState family

| Part                    | Renders  | Props                                                                 | Description                                              |
| ----------------------- | -------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `EmptyState`            | `div`    | `className`                                                           | Root column, `max-w-md`.                                 |
| `EmptyStateGreeting`    | `h2`     | `className`                                                           | Centered heading; fades and slides in first.             |
| `EmptyStateSuggestions` | `div`    | `className`                                                           | Wrapping row for the suggestion buttons.                 |
| `EmptyStateSuggestion`  | `button` | `index?: number` (default `0`), `className`                           | `index` sets the stagger delay (`120ms + index * 70ms`). |
| `EmptyStateComposer`    | `div`    | `placeholder` (required `string`), `onSend?: () => void`, `className` | Same shell as `ChatPanelComposer`; animates in last.     |

All other props for each part forward to its root element.