# Agent plan
URL: /elements/agent-plan

A checklist the agent works through, with progress you can glance.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

A checklist with a header count, a progress bar, and each step marked done, active, or still ahead. With a runtime the plan comes from a tool call the model drives; standalone you hold the step list and the active index yourself.

## Getting started

**With a runtime:**

A plan like this is a natural shape for a tool call: the model calls a tool with the full step list and the index of the step it is currently on.

1. ### Render the tool call

   Register a toolkit entry whose `render` maps the call straight onto `AgentPlan`. Both fields come from `args`, so the card needs nothing beyond what the model already sent.

   ```
   "use client";

   import { defineToolkit } from "@assistant-ui/react";
   import { AgentPlan } from "@/components/assistant-ui/elements/agent-plan";

   export const toolkit = defineToolkit({
     update_plan: {
       type: "backend",
       render: ({ args }) => (
         <AgentPlan steps={args.steps} activeIndex={args.activeIndex} />
       ),
     },
   });
   ```

   The model calls `update_plan` again each time it checks a step off, so a plan reads down the transcript as a short sequence of cards rather than one card mutating in place. The schema and the tool that produces these calls live on your server; only the renderer is shown here.

2. ### Register the toolkit

   ```
   import { AssistantRuntimeProvider, AuiConfig, Tools } from "@assistant-ui/react";
   import { toolkit } from "./toolkit";

   const config = AuiConfig({ tools: Tools({ toolkit }) });

   export function MyRuntimeProvider({ children }: { children: React.ReactNode }) {
     return (
       <AssistantRuntimeProvider runtime={runtime} config={config}>
         {children}
       </AssistantRuntimeProvider>
     );
   }
   ```

   Every `update_plan` call now renders as an `AgentPlan` card wherever it lands in the message.

**Standalone (no runtime):**

Standalone, the element is a controlled display: you own the step list and move `activeIndex` forward as work completes.

1. ### Hold the plan state

   ```
   "use client";

   import { useState } from "react";
   import { AgentPlan } from "@/components/assistant-ui/elements/agent-plan";

   const STEPS = [
     "Read existing composer state",
     "Design the draft store",
     "Wire runtime persistence",
     "Add regression tests",
     "Update the docs",
   ];

   export function Plan() {
     const [activeIndex, setActiveIndex] = useState(0);
     return <AgentPlan steps={STEPS} activeIndex={activeIndex} />;
   }
   ```

2. ### Advance it as work finishes

   ```
   function completeStep() {
     setActiveIndex((i) => i + 1);
   }
   ```

   Once `activeIndex` reaches `steps.length`, every step renders as done and the header reads `n of n`.

## Anatomy

```
<div data-slot="agent-plan">
  <div>
    <span>Plan</span>
    <span>{/* n of m */}</span>
  </div>
  <div>{/* progress bar */}</div>
  <ul>
    <li>
      <span>{/* check, spinner, or dot */}</span>
      <span>{/* step text */}</span>
    </li>
  </ul>
</div>
```

`activeIndex` is clamped into `0…steps.length` before anything is drawn from it, so an out-of-range value never breaks the layout: a value at or past `steps.length` marks every step done, and `NaN` falls back to `0`. A step is done when its index is before the clamped active index or every step is already done, active when it sits exactly at that index, and otherwise still ahead. With an empty `steps` array the header reads `0 of 0`, the bar sits at 0%, and the list renders nothing.

## Examples

### Restyle the plan

Both lanes take `className` on the root. The counter and the icon column share `mono` and `foreground` opacity tokens from `surfaces.tsx`, so a single palette change carries to every element built on those tokens.

```
<AgentPlan className="max-w-md gap-4" steps={steps} activeIndex={activeIndex} />
```

### Restarting a plan

**With a runtime:**

A plan that needs to restart is just another `update_plan` call with `activeIndex` reset to `0`. There is no separate reset action; the next call is the reset.

```
render: ({ args }) => (
  <AgentPlan steps={args.steps} activeIndex={args.activeIndex} />
),
```

**Standalone (no runtime):**

```
function restart() {
  setActiveIndex(0);
}
```

## API reference

**With a runtime:**

### Render props

| Prop               | Type       | Description                              |
| ------------------ | ---------- | ---------------------------------------- |
| `args.steps`       | `string[]` | The plan's steps, in order.              |
| `args.activeIndex` | `number`   | Index of the step currently in progress. |

**Standalone (no runtime):**

### AgentPlan

| Prop          | Type                | Default  | Description                                                                        |
| ------------- | ------------------- | -------- | ---------------------------------------------------------------------------------- |
| `steps`       | `readonly string[]` | required | The plan's steps, in order.                                                        |
| `activeIndex` | `number`            | required | Index of the step in progress. Out-of-range values clamp; `NaN` falls back to `0`. |
| `className`   | `string`            |          | Merged onto the root.                                                              |

All other `div` props are forwarded to the root.