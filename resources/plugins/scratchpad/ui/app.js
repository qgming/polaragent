// 速记本的界面逻辑。
//
// ## 这个文件在演示什么
//
// 一个**模态窗插件**的最小闭环：读私有存储 → 编辑 → 防抖写回 → 复制到剪贴板 → 自己关窗。
// 全部能力都来自 `window.oint`（宿主桥），**没有一行直接碰文件、网络或系统**。
//
// ## 三条来自宿主契约、不写就会踩的约束
//
//  1. **`storage` 的值必须是 JSON 能表达的东西**（字符串 / 数字 / 布尔 / 数组 / 对象）。
//     函数、Date、Map 都不行 —— 它要落盘成 storage.json。
//  2. **单次写入有上限（1 MiB，按序列化后的 JSON 算），超了会抛错**（不是静默截断）。
//     所以这里把失败**显示出来**：静默截断会让用户读到自己的半条笔记，那比报错难查得多。
//  3. **`writeText` 只有写、没有读**，而且会覆盖用户的剪贴板 —— 所以它有明确的用户手势
//     （点"复制"），不做任何自动复制。
//
// 另外：Escape 在这里是**收不到**的（焦点在 guest 里，宿主的对话框拿不到按键），
// 所以关窗有两条明路：宿主对话框右上角的 ✕，以及这个页面自己的"关闭"按钮
// （后者走 `close()`，宿主会因此把对话框收掉）。

(() => {
  const api = window.oint;

  const listEl = document.getElementById("list");
  const textEl = document.getElementById("text");
  const searchEl = document.getElementById("search");
  const countEl = document.getElementById("count");
  const savedEl = document.getElementById("saved");
  const noticeEl = document.getElementById("notice");
  const newEl = document.getElementById("new");
  const copyEl = document.getElementById("copy");
  const deleteEl = document.getElementById("delete");
  const closeEl = document.getElementById("close");

  /*
    宿主没注入 API 时明确说出来。
    真实成因通常有两个：主进程没给这个 webview 装 guest preload，或者归属没登记上
    （后者在 modal-only 插件上曾经是个真问题，见 surfaces.ts 的 claimSurfaceBySession）。
    两种情况都会让页面"能显示但点了没反应"。
  */
  if (api === undefined) {
    listEl.innerHTML = '<p class="empty"><b>宿主桥没接上</b>window.oint 不存在</p>';
    return;
  }

  /** 主题跟随：不跟的话切到深色时这块面板会亮得刺眼 */
  function applyTheme(theme) {
    document.body.dataset.theme = theme === "dark" ? "dark" : "light";
  }
  applyTheme(api.info.theme);
  api.on("theme", (payload) => applyTheme(typeof payload === "string" ? payload : api.info.theme));

  // ── 数据 ────────────────────────────────────────────────────────────────────

  /** 存储键名。**只此一个** —— 整个速记本就是一条笔记数组 */
  const KEY = "notes";

  /** 一条笔记：id 只是本地标识（用来做选择与排序），时间戳是给"刚改过"提示用的 */
  const notes = [];
  let selectedId = null;
  /** 搜索词：只影响列表显示，不影响存储 */
  let filter = "";

  /**
   * 把存储里读到的值收成合法形状。
   *
   * **不信任读到的内容**：storage.json 是我们自己写的，但它是磁盘上的明文文件，
   * 手改过、上一版写的、写到一半断电 —— 都可能让形状对不上。
   * 一条坏记录不该让整个界面打不开，所以坏的那条丢掉，其余照常显示。
   */
  function normalize(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      if (item === null || typeof item !== "object") continue;
      if (typeof item.id !== "string" || typeof item.text !== "string") continue;
      out.push({
        id: item.id,
        text: item.text,
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
      });
    }
    return out;
  }

  /** 落盘用的形状：只留上面三个字段，别把界面状态也写进去 */
  function serializable() {
    return notes.map((note) => ({ id: note.id, text: note.text, updatedAt: note.updatedAt }));
  }

  let saveTimer = 0;
  let saving = false;

  /** 写回存储。失败**必须显示**（超 1 MiB 会抛），否则用户会以为已经存上了 */
  async function flush() {
    if (saving) return;
    saving = true;
    try {
      await api.storage.set(KEY, serializable());
      noticeEl.style.display = "none";
      savedEl.textContent = `已保存 ${new Date().toLocaleTimeString("zh-CN")}`;
    } catch (error) {
      noticeEl.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}（插件存储上限 1 MiB）`;
      noticeEl.style.display = "block";
      savedEl.textContent = "";
    } finally {
      saving = false;
    }
  }

  /**
   * 防抖写回。
   *
   * 400ms 是个取舍：输入过程里每敲一个字都写盘会让 storage.json 反复落盘
   *（宿主是整文件原子写），而更长的窗口会让"关窗即丢最后一次改动"变得可能。
   * 关窗时的那一次由宿主的 webview 卸载兜底 —— 卸载前 `flush()` 会跑完，
   * 因为 Node 侧的写入已经开始、宿主 await 的是它自己的 IPC，不是页面的生命周期。
   */
  function scheduleSave() {
    savedEl.textContent = "正在保存…";
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void flush(), 400);
  }

  const id = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  // ── 渲染 ────────────────────────────────────────────────────────────────────

  /** 一条笔记在列表里的标题：第一行非空内容，没有就给个占位 */
  function titleOf(note) {
    const line = note.text.split("\n").find((value) => value.trim() !== "");
    return line === undefined ? "（空白笔记）" : line.trim().slice(0, 60);
  }

  function selected() {
    return notes.find((note) => note.id === selectedId);
  }

  function visible() {
    const keyword = filter.trim().toLowerCase();
    const matched =
      keyword === ""
        ? [...notes]
        : notes.filter((note) => note.text.toLowerCase().includes(keyword));
    // 最近改动的排在前面：速记本的用法是"刚记的那条最可能要再看"
    return matched.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function renderList() {
    const rows = visible();
    countEl.textContent = filter.trim() === "" ? `${notes.length} 条` : `${rows.length} / ${notes.length}`;

    if (rows.length === 0) {
      listEl.innerHTML =
        notes.length === 0
          ? '<p class="empty"><b>还没有笔记</b>点「新建」开始记</p>'
          : '<p class="empty"><b>没有匹配的笔记</b>换个词试试</p>';
      return;
    }

    const parts = [];
    for (const note of rows) {
      const stamp = note.updatedAt === 0 ? "" : new Date(note.updatedAt).toLocaleString("zh-CN");
      parts.push(
        `<div class="note" data-id="${escapeAttr(note.id)}" data-selected="${
          note.id === selectedId
        }"><div class="note-title">${escapeHtml(titleOf(note))}</div>` +
          `<div class="note-sub">${escapeHtml(stamp)}</div></div>`,
      );
    }
    listEl.innerHTML = parts.join("");
  }

  function renderEditor() {
    const note = selected();
    const has = note !== undefined;
    textEl.value = has ? note.text : "";
    textEl.disabled = !has;
    textEl.placeholder = has
      ? "随手写点什么…"
      : "左边还没有选中笔记 —— 点「新建」或点一条已有的";
    copyEl.disabled = !has || note.text.trim() === "";
    deleteEl.disabled = !has;
    savedEl.textContent = "";
  }

  function render() {
    renderList();
    renderEditor();
  }

  function escapeHtml(value) {
    return value.replace(
      /[&<>"']/g,
      (char) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
    );
  }
  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  // ── 交互 ────────────────────────────────────────────────────────────────────

  /** 新建一条并选中它：光标直接落在编辑器里，用户不用再点一次 */
  function createNote() {
    const note = { id: id(), text: "", updatedAt: Date.now() };
    notes.push(note);
    selectedId = note.id;
    filter = "";
    searchEl.value = "";
    render();
    textEl.focus();
    scheduleSave();
  }

  newEl.addEventListener("click", createNote);

  searchEl.addEventListener("input", () => {
    filter = searchEl.value;
    renderList();
  });

  /*
    列表用**事件委托**：重渲染会整块换掉 innerHTML，逐个元素挂监听会在每次渲染后失效
    （那是"点了没反应"最经典的一种来源）。
  */
  listEl.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest(".note");
    if (row === null) return;
    selectedId = row.dataset.id ?? null;
    render();
  });

  textEl.addEventListener("input", () => {
    const note = selected();
    if (note === undefined) return;
    note.text = textEl.value;
    note.updatedAt = Date.now();
    // 列表要跟着变（标题就是正文第一行），但**不要动编辑器**：重设 value 会把光标顶到末尾
    renderList();
    scheduleSave();
  });

  copyEl.addEventListener("click", async () => {
    const note = selected();
    if (note === undefined) return;
    try {
      await api.writeText(note.text);
      savedEl.textContent = "已复制到剪贴板";
    } catch (error) {
      noticeEl.textContent = `复制失败：${error instanceof Error ? error.message : String(error)}`;
      noticeEl.style.display = "block";
    }
  });

  deleteEl.addEventListener("click", () => {
    const note = selected();
    if (note === undefined) return;
    // 删除是不可逆的（没有回收站），所以问一次 —— 与宿主的审批卡同一个原则：
    // 代价小的确认比事后的道歉便宜
    if (!window.confirm(`删除「${titleOf(note)}」？这一步不能撤销。`)) return;
    const index = notes.findIndex((item) => item.id === note.id);
    if (index !== -1) notes.splice(index, 1);
    selectedId = notes[Math.min(index, notes.length - 1)]?.id ?? null;
    render();
    scheduleSave();
  });

  // 快捷键：Ctrl/Cmd+N 新建（与大多数笔记应用一致），Ctrl/Cmd+S 立刻落盘
  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === "n") {
      event.preventDefault();
      createNote();
    } else if (event.key === "s") {
      event.preventDefault();
      void flush();
    }
  });

  /*
    关窗：先落盘，再请宿主收掉对话框。

    顺序不能反 —— `close()` 之后宿主会摘掉归属登记并卸载这个 guest，
    再想写存储就会被身份闸门挡掉（那时页面已经"不是插件界面"了）。
    `flush()` 里的 `storage.set` 从发起到主进程写完是宿主那边的事，
    所以这里 await 它是有意义的：await 的是宿主的写入确认，不是页面的存活。
  */
  closeEl.addEventListener("click", async () => {
    closeEl.disabled = true;
    await flush();
    try {
      await api.close();
    } catch {
      // 关不掉（归属已被摘等）不是什么需要告诉用户的事：宿主那边也会关
      closeEl.disabled = false;
    }
  });

  // ── 启动 ────────────────────────────────────────────────────────────────────

  /** 启动时读一次存储。读失败按空处理但**说出来** —— 静默空列表会让用户以为笔记丢了 */
  async function start() {
    try {
      notes.push(...normalize(await api.storage.get(KEY)));
    } catch (error) {
      noticeEl.textContent = `读取笔记失败：${error instanceof Error ? error.message : String(error)}`;
      noticeEl.style.display = "block";
    }
    // 默认选中最近改动的那一条：打开就能接着写
    selectedId = visible()[0]?.id ?? null;
    render();
    /*
      报"我画好了"：宿主据此撤掉加载骨架屏。
      **不做成自动的** —— 页面 load 事件早于首屏渲染完成，用它会闪一下。
    */
    await api.ready();
  }

  void start();
})();
