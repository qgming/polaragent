# Thread list sidebar
URL: /elements/thread-list-sidebar

A complete sidebar shell that places the runtime thread list beside the active conversation.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

Thread list sidebar wraps the runtime [Thread list](/elements/thread-list) in a full collapsible sidebar shell: a header, a footer, and an optional rail for collapsing it. It has no standalone form, since it renders the runtime-only thread list internally and forwards every other prop straight to the underlying `Sidebar` shell.

## Getting started

**With a runtime:**

`ThreadListSidebar` needs a runtime provider and the sidebar shell's own layout provider around it.

1. ### Compose it with a Thread

   ```
   import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
   import { ThreadListSidebar } from "@/components/assistant-ui/elements/threadlist-sidebar.aui";
   import { Thread } from "@/components/assistant-ui/elements/thread.aui";

   export default function Layout() {
     return (
       <SidebarProvider>
         <ThreadListSidebar />
         <SidebarInset>
           <Thread />
         </SidebarInset>
       </SidebarProvider>
     );
   }
   ```

   Needs an `AssistantRuntimeProvider` ancestor around the whole tree. `SidebarProvider` is the sidebar shell's own layout context, unrelated to the runtime; both are required.

**Standalone (no runtime):**

Thread list sidebar has no standalone form: it renders the runtime-only thread list internally, with no prop to swap in a static one. For a non-runtime sidebar, compose `Sidebar` yourself around the standalone lane of [Thread list](/elements/thread-list).

## Anatomy

```
<Sidebar {...props}>
  <SidebarHeader>{/* assistant-ui wordmark, links out */}</SidebarHeader>
  <SidebarContent>
    <ThreadList />
  </SidebarContent>
  {props.collapsible !== "none" && <SidebarRail />}
  <SidebarFooter>{/* GitHub link */}</SidebarFooter>
</Sidebar>
```

The header links out to assistant-ui.com and the footer to its GitHub repository; both are placeholders meant to be replaced with your own branding and support links. The collapse rail renders only when `collapsible` is not `"none"`, following whatever `Sidebar` itself was given.

## Examples

### Change the collapse behavior

```
<ThreadListSidebar collapsible="icon" />
```

Every `Sidebar` prop passes straight through, `collapsible`, `side`, and `variant` included, since `ThreadListSidebar` only adds the header, footer, and thread list between them.

### Replace the header and footer branding

`ThreadListSidebar` does not expose header or footer content as props. Replace the literal links in your copy of `threadlist-sidebar.aui.tsx` with your own product name and support link.

### Add a trigger to open it

```
import { SidebarTrigger } from "@/components/ui/sidebar";

<SidebarTrigger />;
```

Place it inside `SidebarInset`, on the main-pane side, to toggle the sidebar from anywhere in your app.

## API reference

**With a runtime:**

### ThreadListSidebarProps

Extends `React.ComponentProps<typeof Sidebar>`; every prop is forwarded.

| Prop          | Type                                 | Default       | Description                                       |
| ------------- | ------------------------------------ | ------------- | ------------------------------------------------- |
| `side`        | `"left" \| "right"`                  | `"left"`      | Which edge the sidebar docks to.                  |
| `variant`     | `"sidebar" \| "floating" \| "inset"` | `"sidebar"`   | Sidebar chrome style.                             |
| `collapsible` | `"offcanvas" \| "icon" \| "none"`    | `"offcanvas"` | How it collapses. `"none"` also removes the rail. |