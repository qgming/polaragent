# Terminal block
URL: /elements/terminal-block

Command output that streams line by line and ends with an exit status.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

A terminal block echoes a command and reveals its output one line at a time, ending in a checkmark once it settles or a blinking cursor while it runs. With a runtime the command and its lines come from a tool call's args and result; standalone you supply both directly.

## Getting started

**With a runtime:**

1. ### Render the tool call

   ```
   "use client";

   import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
   import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block";

   type RunCommandArgs = { command: string };
   type RunCommandResult = { output: string };

   export const RunCommandToolUI: ToolCallMessagePartComponent<
     RunCommandArgs,
     RunCommandResult
   > = ({ args, result, status }) => {
     const lines = result ? result.output.split("\n") : [];
     return (
       <TerminalBlock
         command={args.command ?? ""}
         lines={lines}
         visibleCount={lines.length}
         done={status.type !== "running"}
       />
     );
   };
   ```

2. ### Register the tool

   ```
   import { defineToolkit } from "@assistant-ui/react";
   import { RunCommandToolUI } from "@/components/assistant-ui/elements/run-command-tool-ui";

   export const toolkit = defineToolkit({
     run_command: {
       type: "backend",
       render: RunCommandToolUI,
     },
   });
   ```

   ```
   import { AssistantRuntimeProvider, AuiConfig, Tools } from "@assistant-ui/react";
   import { useChatRuntime } from "@assistant-ui/ai-sdk";
   import { toolkit } from "./toolkit";

   export function MyRuntimeProvider({ children }: { children: React.ReactNode }) {
     const runtime = useChatRuntime();
     const config = AuiConfig({ tools: Tools({ toolkit }) });
     return (
       <AssistantRuntimeProvider runtime={runtime} config={config}>
         {children}
       </AssistantRuntimeProvider>
     );
   }
   ```

   The backend that owns `run_command` supplies its schema and executor; see [Backend tools](/docs/tools/backend).

**Standalone (no runtime):**

1. ### Hold the command and its lines

   ```
   "use client";

   import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block";

   const LINES = ["RUN v4.0.5", "✓ 3 tests passed"] as const;

   export function TestRun() {
     return (
       <TerminalBlock
         command="pnpm vitest run"
         lines={LINES}
         visibleCount={LINES.length}
         done
       />
     );
   }
   ```

2. ### Show it running

   Flip `done` to `false` while the process is in flight; the header swaps its checkmark for a spinner and a cursor blinks after the last visible line:

   ```
   <TerminalBlock command="pnpm vitest run" lines={LINES} visibleCount={1} done={false} />
   ```

## Anatomy

```
<div data-slot="terminal-block">
  <div>{/* command text, a spinner while running, a checkmark + "exit 0" once done */}</div>
  <div>{/* lines revealed up to visibleCount; the last line stays bright; a blinking cursor while !done */}</div>
</div>
```

The exit line always reads `exit 0` regardless of the real outcome: `done` only switches the header between a spinner and a checkmark, there is no prop for a nonzero exit code or a failed run. The body reserves a minimum height so the block does not resize as lines arrive. `visibleCount` clamps to the length of `lines`, and only the most recently revealed line renders at full opacity; earlier lines settle to a dimmer tone.

## Examples

### Ink variant

`variant="ink"` inverts the block to a solid dark panel and lightens the text against it. Every other prop and all behavior stay identical.

```
<TerminalBlock variant="ink" command="pnpm vitest run" lines={LINES} visibleCount={2} done />
```

### Restyle the terminal

Both lanes take `className` on the root. The paper variant's background and border come from the shared `paper` token in `surfaces.tsx`; the ink variant sets its own background directly.

```
<TerminalBlock className="max-w-none" /* ... */ />
```

**Standalone (no runtime):**

### Replaying output

Grow `visibleCount` on a timer to replay a captured run line by line, the way the catalog's own preview does:

```
const [visibleCount, setVisibleCount] = useState(0);

useEffect(() => {
  if (visibleCount >= LINES.length) return;
  const id = setTimeout(() => setVisibleCount((n) => n + 1), 700);
  return () => clearTimeout(id);
}, [visibleCount]);
```

## API reference

**With a runtime:**

### Tool-call render props

| Prop     | Type                              | Description                                                       |
| -------- | --------------------------------- | ----------------------------------------------------------------- |
| `args`   | `{ command: string }`             | The command the model asked to run.                               |
| `result` | `{ output: string } \| undefined` | The captured output, once the call completes.                     |
| `status` | `ToolCallMessagePartStatus`       | `status.type === "running"` while the process is still executing. |

See [Tool UI](/docs/tools/tool-ui) for the full render-prop surface and for backend tool registration.

**Standalone (no runtime):**

### TerminalBlock

| Prop           | Type                | Default   | Description                                                                        |
| -------------- | ------------------- | --------- | ---------------------------------------------------------------------------------- |
| `command`      | `string`            | required  | The command line shown in the header.                                              |
| `lines`        | `readonly string[]` | required  | Output lines, in order.                                                            |
| `visibleCount` | `number`            | required  | How many lines from the start of `lines` to render.                                |
| `done`         | `boolean`           | required  | Swaps the header between a spinner and a checkmark, and hides the blinking cursor. |
| `variant`      | `"paper" \| "ink"`  | `"paper"` | Visual surface.                                                                    |
| `className`    | `string`            |           | Merged onto the root.                                                              |

All other `div` props are forwarded to the root.