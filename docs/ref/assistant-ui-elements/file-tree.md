# File tree
URL: /elements/file-tree

Everything a run touched, as a tree, with the churn spelled out per file.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

A file tree lists everything a run touched: a "N files changed" header with net totals, then one row per file, each indented under a folder heading and carrying its own added and deleted line counts. With a runtime you map a tool's flat result onto the tree yourself; standalone you supply the rows directly.

## Getting started

**With a runtime:**

1. ### Derive the tree from a flat result

   A tool result is naturally a flat list of touched files. Group it into folder headers and indented file rows before handing it to the element:

   ```
   "use client";

   import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
   import { FileTree, type FileTreeNode } from "@/components/assistant-ui/elements/file-tree";

   type ChangedFile = { path: string; additions: number; deletions: number };
   type ListChangesResult = { files: readonly ChangedFile[] };

   function buildFileTree(files: readonly ChangedFile[]): FileTreeNode[] {
     const nodes: FileTreeNode[] = [];
     const seenDirs = new Set<string>();

     for (const file of files) {
       const slash = file.path.lastIndexOf("/");
       const dir = slash === -1 ? "" : file.path.slice(0, slash);
       const name = slash === -1 ? file.path : file.path.slice(slash + 1);

       if (dir && !seenDirs.has(dir)) {
         seenDirs.add(dir);
         nodes.push({ path: dir, name: dir, depth: 0, kind: "folder" });
       }

       nodes.push({
         path: file.path,
         name,
         depth: dir ? 1 : 0,
         kind: "file",
         additions: file.additions,
         deletions: file.deletions,
       });
     }

     return nodes;
   }

   export const ListChangesToolUI: ToolCallMessagePartComponent<
     Record<string, never>,
     ListChangesResult
   > = ({ result }) => {
     if (!result) return null;
     const nodes = buildFileTree(result.files);
     return (
       <FileTree
         nodes={nodes}
         visibleCount={nodes.length}
         totalAdditions={result.files.reduce((n, f) => n + f.additions, 0)}
         totalDeletions={result.files.reduce((n, f) => n + f.deletions, 0)}
       />
     );
   };
   ```

2. ### Register the tool

   ```
   import { defineToolkit } from "@assistant-ui/react";
   import { ListChangesToolUI } from "@/components/assistant-ui/elements/list-changes-tool-ui";

   export const toolkit = defineToolkit({
     list_changes: {
       type: "backend",
       render: ListChangesToolUI,
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

**Standalone (no runtime):**

1. ### Hold the nodes

   ```
   "use client";

   import { FileTree, type FileTreeNode } from "@/components/assistant-ui/elements/file-tree";

   const NODES: readonly FileTreeNode[] = [
     { path: "packages/core/src", name: "packages/core/src", depth: 0, kind: "folder" },
     {
       path: "converter",
       name: "convertMessages.ts",
       depth: 1,
       kind: "file",
       additions: 24,
       deletions: 6,
     },
     { path: "changeset", name: ".changeset/tidy-pans.md", depth: 0, kind: "file", additions: 5 },
   ];

   export function Changes() {
     return (
       <FileTree
         nodes={NODES}
         visibleCount={NODES.length}
         totalAdditions={29}
         totalDeletions={6}
       />
     );
   }
   ```

2. ### Reveal rows over time

   Grow `visibleCount` on a timer to have rows fade in as if a run were still discovering them:

   ```
   const [visibleCount, setVisibleCount] = useState(0);

   useEffect(() => {
     if (visibleCount >= NODES.length) return;
     const id = setTimeout(() => setVisibleCount((n) => n + 1), 420);
     return () => clearTimeout(id);
   }, [visibleCount]);
   ```

## Anatomy

```
<div data-slot="file-tree">
  <div>{/* "N files changed", total +additions and −deletions */}</div>
  <div>{/* one row per visible node, indented by depth × 0.85rem */}</div>
</div>
```

`path` is used only as the React key; nothing about a row's position is derived from it. `depth` and `kind` are independent fields you assign to every node yourself, so a folder row is a static, non-interactive header, never a real parent of the rows beneath it, and it never collapses. The "N files changed" count only tallies `kind: "file"` nodes, so folder headers never inflate it. A file's own additions or deletions badge is omitted, not shown as zero, when that field is `undefined`; the header's totals always render, even at zero.

## Examples

### Restyle the tree

Both lanes take `className` on the root. The card surface and the count badges come from the shared `paper` and `mono` tokens in `surfaces.tsx`.

```
<FileTree className="max-w-none" /* ... */ />
```

### A file with no folder

Because `depth` and `kind` are independent per node, a file can sit at the root with no folder heading above it. This is how a loose file like a changeset entry shows up in the catalog's own preview:

```
{ path: "changeset", name: ".changeset/tidy-pans.md", depth: 0, kind: "file", additions: 5 }
```

**With a runtime:**

### When the tool already returns a tree

Skip `buildFileTree` entirely if the tool result already carries pre-shaped nodes:

```
export const ListChangesToolUI: ToolCallMessagePartComponent<
  Record<string, never>,
  { files: readonly FileTreeNode[]; additions: number; deletions: number }
> = ({ result }) =>
  result ? (
    <FileTree
      nodes={result.files}
      visibleCount={result.files.length}
      totalAdditions={result.additions}
      totalDeletions={result.deletions}
    />
  ) : null;
```

## API reference

**With a runtime:**

### Tool-call render props

| Prop     | Type                                             | Description                                              |
| -------- | ------------------------------------------------ | -------------------------------------------------------- |
| `result` | `{ files: readonly ChangedFile[] } \| undefined` | The flat list of touched files, once the call completes. |

There is no built-in path-to-tree helper: map the flat list to `FileTreeNode[]` yourself, the way `buildFileTree` does above, or have your tool return pre-shaped nodes directly. See [Tool UI](/docs/tools/tool-ui) for the full render-prop surface.

**Standalone (no runtime):**

### FileTree

| Prop             | Type                      | Default  | Description                                        |
| ---------------- | ------------------------- | -------- | -------------------------------------------------- |
| `nodes`          | `readonly FileTreeNode[]` | required | The full row list, in order.                       |
| `visibleCount`   | `number`                  | required | How many rows from the start of `nodes` to render. |
| `totalAdditions` | `number`                  | required | Green count in the header.                         |
| `totalDeletions` | `number`                  | required | Red count in the header.                           |
| `className`      | `string`                  |          | Merged onto the root.                              |

`FileTreeNode` is `{ path: string; name: string; depth: number; kind: "folder" | "file"; additions?: number; deletions?: number }`. All other `div` props are forwarded to the root.