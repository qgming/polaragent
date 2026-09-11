# Regenerate with
URL: /elements/regenerate-menu

Fork the same turn to a different model instead of rolling the same dice.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

RegenerateMenu turns the regenerate action into a small picker: open it, see the alternatives with the current one marked, and pick one to try again. With a runtime picking an option starts a new run carrying your choice; standalone you own the open state and the pick.

## Getting started

**With a runtime:**

`aui.message.reload(config)` starts a new run for the current turn, and `config.runConfig.custom` reaches your model adapter untouched. assistant-ui itself has no built-in "model" field on a run; on a `useLocalRuntime` plus `ChatModelAdapter` runtime, this is exactly what `ChatModelAdapter.run(options)` receives as `options.runConfig`, so a custom adapter reads the pick back out for that one run only, without changing what later turns use.

1. ### Wire picks to reload

   ```
   "use client";

   import { useState } from "react";
   import { useAui } from "@assistant-ui/react";
   import { RegenerateMenu, type RegenerateOption } from "@/components/assistant-ui/elements/regenerate-menu";

   const MODELS: RegenerateOption[] = [
     { id: "opus", label: "Try again with Opus 5", detail: "slower" },
     { id: "sonnet", label: "Try again with Sonnet 5", detail: "balanced" },
     { id: "haiku", label: "Try again with Haiku 4.5", detail: "fastest" },
   ];

   function RegenerateWith({ currentModel }: { currentModel: string }) {
     const aui = useAui();
     const [open, setOpen] = useState(false);

     return (
       <RegenerateMenu
         options={MODELS}
         open={open}
         currentId={currentModel}
         onOpenChange={setOpen}
         onPick={(id) => {
           aui.message.reload({ runConfig: { custom: { model: id } } });
           setOpen(false);
         }}
       />
     );
   }
   ```

2. ### Read the pick on the model side

   ```
   import type { ChatModelAdapter } from "@assistant-ui/react";

   export const adapter: ChatModelAdapter = {
     async run({ messages, runConfig, abortSignal }) {
       const model = (runConfig.custom?.model as string | undefined) ?? "sonnet";
       // call `model` for this run
     },
   };
   ```

**Standalone (no runtime):**

Standalone, the menu is fully controlled: open state, the current pick, and what happens on a pick are all yours.

1. ### Hold the open and current state

   ```
   "use client";

   import { useState } from "react";
   import { RegenerateMenu, type RegenerateOption } from "@/components/assistant-ui/elements/regenerate-menu";

   const OPTIONS: RegenerateOption[] = [
     { id: "opus", label: "Try again with Opus 5", detail: "slower" },
     { id: "sonnet", label: "Try again with Sonnet 5", detail: "balanced" },
   ];

   export function Answer() {
     const [open, setOpen] = useState(false);
     const [model, setModel] = useState("sonnet");

     return (
       <RegenerateMenu
         options={OPTIONS}
         open={open}
         currentId={model}
         onOpenChange={setOpen}
         onPick={(id) => {
           setModel(id);
           setOpen(false);
           regenerate(id);
         }}
       />
     );
   }
   ```

2. ### Handle outside interaction yourself

   The component has no built-in outside-click or Escape handling; it is a bare conditional render behind `open`. Wrap it in your own popover primitive, or listen for outside clicks yourself, if you need the menu to close on its own.

## Anatomy

```
<div data-slot="regenerate-menu">
  <button aria-expanded aria-label="Regenerate with a different model" />
  {open && (
    <div>
      {/* one row per option: its label, and "current" in place of the detail for the active one */}
    </div>
  )}
</div>
```

No outside-click, Escape, or keyboard roving is built in; every row is a plain button. The active option (`option.id === currentId`) shows the literal text "current" in place of its own `detail`, so a `detail` string that happens to read "current" is indistinguishable from the real thing.

## Examples

### Regenerating with the same model

**With a runtime:**

`reload()` with no config just retries the current turn as-is; the override in `runConfig.custom` is only needed when you actually want a different model:

```
<button onClick={() => aui.message.reload()}>Try again</button>
```

**Standalone (no runtime):**

Nothing requires the menu to be open for a pick to happen; call `onPick` directly, for example from a keyboard shortcut bound to the current model's id.

```
onPick(currentId);
```

### Restyle the trigger and menu

Both lanes take `className` on the root. The dropdown reads the shared `floating` surface from `surfaces.tsx`, the same token popovers and tooltips use elsewhere.

```
<RegenerateMenu className="gap-1" /* ... */ />
```

## API reference

**With a runtime:**

### Message state

| Selector / method             | Type                                           | Description                                                                                                                       |
| ----------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `aui.message.reload(config?)` | `(config?: { runConfig?: RunConfig }) => void` | Starts a new run for this turn. `runConfig.custom` reaches your `ChatModelAdapter` as `options.runConfig.custom`, untouched.      |
| `RunConfig`                   | `{ custom?: Record<string, unknown> }`         | The shape `reload`'s `runConfig` accepts. assistant-ui has no built-in model field; the key you read back is your own convention. |

**Standalone (no runtime):**

### RegenerateMenu

| Prop           | Type                          | Default  | Description                                                    |
| -------------- | ----------------------------- | -------- | -------------------------------------------------------------- |
| `options`      | `readonly RegenerateOption[]` | required | The alternatives offered.                                      |
| `open`         | `boolean`                     | required | Whether the dropdown is shown.                                 |
| `currentId`    | `string`                      | required | Id shown as "current". A non-matching id marks no row current. |
| `onOpenChange` | `(open: boolean) => void`     |          | Called when the trigger is pressed, with the next open value.  |
| `onPick`       | `(id: string) => void`        |          | Called when a row is pressed. Does not close the menu itself.  |
| `className`    | `string`                      |          | Merged onto the root.                                          |

### RegenerateOption

| Field    | Type     | Description                                    |
| -------- | -------- | ---------------------------------------------- |
| `id`     | `string` |                                                |
| `label`  | `string` |                                                |
| `detail` | `string` | Shown for every option except the current one. |

All other `div` props are forwarded to the root.