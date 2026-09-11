# Error state
URL: /elements/error-state

A quiet failure banner with a retry path, not a modal in your face.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

When a reply fails, this sits where the message would have been: a quiet red banner naming what went wrong with a retry button, or, while retrying, a single spinning line reading "Retrying". With a runtime the failure and the retry both come from the message itself; standalone you hold the title, detail, and retry state yourself.

## Getting started

**With a runtime:**

An assistant message that failed mid-run carries its error on `s.message.status`; `MessagePrimitive.Error` only renders its children while one is present, so you never need to check for it yourself.

1. ### Render the failed message

   ```
   "use client";

   import { ErrorPrimitive, MessagePrimitive } from "@assistant-ui/react";
   import { CircleAlertIcon } from "lucide-react";

   export function MessageError() {
     return (
       <MessagePrimitive.Error>
         <ErrorPrimitive.Root className="flex items-start gap-2.5 rounded-2xl bg-red-500/[0.06] px-4 py-3 text-sm dark:bg-red-500/10">
           <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-red-500/80" />
           <ErrorPrimitive.Message className="text-red-600 dark:text-red-400" />
         </ErrorPrimitive.Root>
       </MessagePrimitive.Error>
     );
   }
   ```

   `ErrorPrimitive.Root` renders as `role="alert"`; `ErrorPrimitive.Message` reads the error itself (`s.message.status.type === "incomplete" && s.message.status.reason === "error"`) and falls back to `String(error)` when you don't pass children, so there's a single message string here rather than a separate title and detail.

2. ### Wire the retry button

   `ActionBarPrimitive.Reload` calls `aui.message.reload()`, which re-runs from this message's parent and is disabled while the thread is already running:

   ```
   import { ActionBarPrimitive } from "@assistant-ui/react";
   import { RefreshCwIcon } from "lucide-react";

   <ActionBarPrimitive.Reload className="ms-auto flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400">
     <RefreshCwIcon className="size-3" />
     Retry
   </ActionBarPrimitive.Reload>
   ```

**Standalone (no runtime):**

Standalone, `ErrorState` switches its whole layout on `retrying`: a two-line alert with a title and detail, or a single spinning status line.

1. ### Hold the failure and drive retry

   ```
   "use client";

   import { useState } from "react";
   import { ErrorState } from "@/components/assistant-ui/elements/error-state";

   export function ReplyError() {
     const [retrying, setRetrying] = useState(false);
     const [failed, setFailed] = useState(true);

     if (!failed) return null;

     return (
       <ErrorState
         title="Couldn't reach the model"
         detail="The request timed out after 30 seconds."
         retrying={retrying}
         onRetry={async () => {
           setRetrying(true);
           const ok = await retry();
           setRetrying(false);
           setFailed(!ok);
         }}
       />
     );
   }
   ```

2. ### Drop it once the retry lands

   There's no built-in success state; unmount `ErrorState` (as above, on `failed` turning false) once the retried request comes back clean, so the banner gives way to the reply it stood in for.

## Anatomy

```
<div data-slot="error-state" role="alert">
  <svg /> {/* alert icon */}
  <div>
    <p>{/* title */}</p>
    <p>{/* detail */}</p>
  </div>
  <button>Retry</button>
</div>
```

While `retrying` is true, the whole layout swaps to a single row with `role="status"` instead of `role="alert"`: a spinning refresh icon and a shimmering "Retrying" label, no title, detail, or button. Both states share the `error-state` slot and fade in over 300ms whenever the component (re)mounts, since `key="error"`/`key="retrying"` force a fresh mount on each switch. At runtime there's only one such state: `ErrorPrimitive.Root` is always `role="alert"`, and there's no shipped "retrying" sub-state. Reproduce it yourself by watching `s.thread.isRunning` for the message you just reloaded, and falling back to the error banner again if the new attempt also fails.

## Examples

### While retrying

**Standalone (no runtime):**

Flip `retrying` around the async call in `onRetry`, as shown in "Hold the failure and drive retry"; the banner swaps to the status line for exactly as long as the promise is pending.

**With a runtime:**

Reloading is fire-and-forget from the button's point of view; watch `s.thread.isRunning` if you want your own "Retrying" line while the new attempt streams in:

```
const retrying = useAuiState((s) => s.thread.isRunning);
```

### Where the error text comes from

**With a runtime:**

`useMessageError()` returns the same string `ErrorPrimitive.Message` falls back to: the run's `status.error`, coerced to a string, an `error.message` when the error is object-shaped, or `"An error occurred"` when neither is available. Call it directly if you need the text outside `MessagePrimitive.Error`.

```
const error = useMessageError();
```

**Standalone (no runtime):**

`title` and `detail` are just the two strings you pass; split your caught error into a short title and a longer detail however makes sense for your source (a fetch error's `name` and `message`, for instance).

### Restyle the banner

Both lanes take `className` on the root; the failure banner's red tint and the retrying row's shimmer are the only two visual states to restyle.

```
<ErrorState className="max-w-none" /* ... */ />
```

## API reference

**With a runtime:**

### MessagePrimitive and ErrorPrimitive

| Part                        | Renders  | Notes                                                                  |
| --------------------------- | -------- | ---------------------------------------------------------------------- |
| `MessagePrimitive.Error`    | fragment | Renders children only while the message carries an error.              |
| `ErrorPrimitive.Root`       | `div`    | `role="alert"`.                                                        |
| `ErrorPrimitive.Message`    | `span`   | The error text; pass children to override the default fallback.        |
| `ActionBarPrimitive.Reload` | `button` | Regenerates the message; disabled while the thread is already running. |

### Message state

| Selector                      | Type                                                           | Description                                                            |
| ----------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `s.message.status?.type`      | `"running" \| "complete" \| "incomplete" \| "requires-action"` | `"incomplete"` with `reason: "error"` is what a failed run looks like. |
| `useMessageError()`           | `() => string \| undefined`                                    | The error text, or `undefined` when the message didn't fail.           |
| `aui.message.reload(config?)` | `(config?: { runConfig?: RunConfig }) => void`                 | Retries by regenerating this message.                                  |

**Standalone (no runtime):**

### ErrorState

| Prop        | Type         | Default  | Description                                                |
| ----------- | ------------ | -------- | ---------------------------------------------------------- |
| `title`     | `string`     | required | The short failure headline.                                |
| `detail`    | `string`     | required | The longer explanation shown under the title.              |
| `retrying`  | `boolean`    | required | Swaps the whole layout to the single spinning status line. |
| `onRetry`   | `() => void` | required | Called when the retry button is pressed.                   |
| `className` | `string`     |          | Merged onto the root.                                      |

All other `div` props (excluding `role`, which the component sets itself) are forwarded to the root.