# Settings
URL: /elements/settings-panel

Model, system prompt, temperature, and what the assistant is allowed to do.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

A single card for the knobs a user is allowed to turn themselves: which model answers, what it is told to be, how loose its answers are, and a set of on/off capabilities. With a runtime these values feed a registered model context so they reach every request; standalone they are plain controlled inputs you read back yourself.

## Getting started

**With a runtime:**

None of the panel's values live in the runtime by default; you hold them as component state and register them as a model context provider, the same mechanism `useAssistantInstructions` and the model selector use internally. Every request after that carries whatever the panel currently holds.

1. ### Register the panel's values as model context

   ```
   "use client";

   import { useEffect, useState } from "react";
   import { useAui } from "@assistant-ui/react";
   import {
     SettingsPanel,
     type SettingToggle,
   } from "@/components/assistant-ui/elements/settings-panel";

   const MODELS = ["gpt-5.6-terra", "gpt-5.6-sol"];

   export function ModelSettings() {
     const aui = useAui();
     const [model, setModel] = useState(MODELS[0]!);
     const [systemPrompt, setSystemPrompt] = useState("You are a concise assistant.");
     const [temperature, setTemperature] = useState(0.7);
     const [webSearch, setWebSearch] = useState(false);

     useEffect(() => {
       return aui.modelContext.register({
         getModelContext: () => ({
           system: systemPrompt,
           callSettings: { temperature },
           config: { modelName: model },
         }),
       });
     }, [aui, model, systemPrompt, temperature]);

     const toggles: SettingToggle[] = [
       {
         key: "web-search",
         label: "Web search",
         detail: "Look things up before answering",
         on: webSearch,
       },
     ];

     return (
       <SettingsPanel
         model={model}
         models={MODELS}
         systemPrompt={systemPrompt}
         temperature={temperature}
         toggles={toggles}
         onModelChange={setModel}
         onSystemPromptChange={setSystemPrompt}
         onTemperatureChange={setTemperature}
         onToggle={(key) => key === "web-search" && setWebSearch((w) => !w)}
       />
     );
   }
   ```

   Registration re-runs whenever `model`, `systemPrompt`, or `temperature` changes, so the effect's cleanup unregisters the stale provider before the new one takes over; nothing is sent until the next request.

**Standalone (no runtime):**

Standalone, every value is a prop and every change is a callback; the panel computes nothing beyond clamping temperature into range for display.

1. ### Hold the settings state

   ```
   "use client";

   import { useState } from "react";
   import {
     SettingsPanel,
     type SettingToggle,
   } from "@/components/assistant-ui/elements/settings-panel";

   export function Settings() {
     const [model, setModel] = useState("balanced");
     const [systemPrompt, setSystemPrompt] = useState("You are a helpful assistant.");
     const [temperature, setTemperature] = useState(1);
     const [toggles, setToggles] = useState<SettingToggle[]>([
       { key: "code", label: "Code execution", detail: "Run snippets in a sandbox", on: true },
       { key: "memory", label: "Memory", detail: "Remember facts across chats", on: false },
     ]);

     return (
       <SettingsPanel
         model={model}
         models={["fast", "balanced", "careful"]}
         systemPrompt={systemPrompt}
         temperature={temperature}
         toggles={toggles}
         onModelChange={setModel}
         onSystemPromptChange={setSystemPrompt}
         onTemperatureChange={setTemperature}
         onToggle={(key) =>
           setToggles((prev) => prev.map((t) => (t.key === key ? { ...t, on: !t.on } : t)))
         }
       />
     );
   }
   ```

## Anatomy

```
<div data-slot="settings-panel">
  <div>
    <span>{/* "model" */}</span>
    <div>{/* one segmented button per model in `models` */}</div>
  </div>
  <div>
    <span>{/* "system prompt" */}</span>
    <textarea aria-label="System prompt" />
  </div>
  <div>
    <span>{/* "temperature" */}</span>
    <span>{/* the clamped value, one decimal */}</span>
    <input type="range" aria-label="Temperature" />
  </div>
  <div>{/* one row per toggle: label, detail, switch */}</div>
</div>
```

`temperature` is clamped into `0…2` before it is displayed or handed to the range input, and a `NaN` clamps to `0`, so a bad value never reaches the DOM as an invalid attribute. Nothing in this element disables itself: the model buttons, textarea, slider, and every switch stay interactive regardless of the other fields' values, and an empty `models` or `toggles` array simply renders that section with nothing in it rather than a placeholder message. The model control uses `aria-pressed` on plain buttons rather than radio semantics, and each toggle is a real `role="switch"` with `aria-checked`, not a styled checkbox.

## Examples

### Where the values go

**With a runtime:**

A registered provider reaches your backend the same way a manual `ModelSelector` selection does: `AssistantChatTransport` puts `config`, `system`, and `callSettings` in every chat request's body as sibling fields, so your route reads all three straight off the parsed JSON.

```
export async function POST(req: Request) {
  const { messages, config, system, callSettings } = await req.json();
  const result = streamText({
    model: openai(config?.modelName ?? "gpt-5.6-terra"),
    temperature: callSettings?.temperature,
    system,
    messages: await convertToModelMessages(messages),
  });
  return result.toUIMessageStreamResponse();
}
```

A toggle can gate more than a value in `config`: include or omit an entry in the same provider's `tools` based on the toggle's `on` value, using whatever tool definition your app already registers elsewhere, and the model stops being offered that tool the instant the switch flips.

**Standalone (no runtime):**

Standalone, nothing leaves the component: `onModelChange`, `onSystemPromptChange`, `onTemperatureChange`, and `onToggle` are the only way values escape, so persisting them (to a database, to `localStorage`) is entirely up to the callbacks you pass in.

### Restyle the panel

Both lanes take `className` on the root. The segmented control, textarea, and slider all sit on the `field` surface and the section labels use the shared `mono` token, so retheming those two covers every row at once.

```
<SettingsPanel className="max-w-xs" /* ... */ />
```

## API reference

**With a runtime:**

This element has no dedicated primitive; it registers a plain `ModelContextProvider`, as in Getting started.

### Model context

| Selector / method                     | Type                                              | Description                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aui.modelContext.register(provider)` | `(provider: ModelContextProvider) => Unsubscribe` | Registers a provider whose `getModelContext()` is merged into every outgoing request. Call the returned function (or let a `useEffect` cleanup call it) to unregister. |
| `s.modelContext.modelName`            | `string \| undefined`                             | The `config.modelName` currently in effect after merging every registered provider.                                                                                    |
| `s.modelContext.toolNames`            | `readonly string[]`                               | Names of every tool currently registered across all providers.                                                                                                         |

`ModelContext` itself accepts `system` (a string appended to the outgoing system prompt), `callSettings` (a `LanguageModelV1CallSettings`, including `temperature`), `config` (a `LanguageModelConfig`, including `modelName`), and `tools`.

**Standalone (no runtime):**

### SettingsPanel

| Prop                   | Type                            | Default  | Description                                                        |
| ---------------------- | ------------------------------- | -------- | ------------------------------------------------------------------ |
| `model`                | `string`                        | required | The selected value from `models`.                                  |
| `models`               | `readonly string[]`             | required | Options shown in the segmented control.                            |
| `systemPrompt`         | `string`                        | required | Textarea value.                                                    |
| `temperature`          | `number`                        | required | Slider value. Clamped into `0…2` for display; `NaN` clamps to `0`. |
| `toggles`              | `readonly SettingToggle[]`      | required | Rows shown below the slider.                                       |
| `onModelChange`        | `(model: string) => void`       |          | Called with the pressed model's value.                             |
| `onSystemPromptChange` | `(prompt: string) => void`      |          | Called on every textarea change.                                   |
| `onTemperatureChange`  | `(temperature: number) => void` |          | Called with the slider's raw (unclamped) value.                    |
| `onToggle`             | `(key: string) => void`         |          | Called with a toggle's `key` when its switch is pressed.           |
| `className`            | `string`                        |          | Merged onto the root.                                              |

All other `div` props are forwarded to the root.

### SettingToggle

| Field    | Type      | Description                           |
| -------- | --------- | ------------------------------------- |
| `key`    | `string`  | Identifier passed back to `onToggle`. |
| `label`  | `string`  | Row title.                            |
| `detail` | `string`  | Secondary line under the title.       |
| `on`     | `boolean` | Switch position.                      |