// Git 状态面板。
//
// 数据全部来自 `window.oint.exec("git", [...])` —— 宿主会核对清单里的
// `shell.exec: ["git"]` 白名单，在**当前会话的工作目录**里执行。
//
// 三条来自宿主契约、不写就会踩的约束：
//  1. **参数逐项传，不经过 shell** —— 所以路径里有空格也不用引号包起来；
//  2. **命令失败不抛异常，靠退出码表达** —— `git diff --quiet` 用 1 表示"有改动"，
//     所以要判的是 `code`，不是 try/catch；
//  3. **`cwd` 默认就是工作目录**，不需要（也不能）自己拼绝对路径。

(() => {
  const api = window.oint;
  const branchEl = document.getElementById("branch");
  const trackEl = document.getElementById("track");
  const listEl = document.getElementById("list");
  const refreshEl = document.getElementById("refresh");

  /*
    宿主没注入 API 时明确说出来。
    真实成因通常有两个：主进程没给这个 src 装 guest preload，或者窗口是用
    `loadURL` 之外的方式打开的 —— 两者都会让页面"能显示但点了没反应"。
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

  /** 跑一条 git 命令，返回 stdout（去掉首尾空白）。失败返回 null */
  async function git(args) {
    const result = await api.exec("git", args);
    // **非 0 退出码是正常结果**（"不是 git 仓库"、"没有 upstream"都走这里），
    // 所以不当异常处理，交给调用方判
    return result.code === 0 ? result.stdout.trim() : null;
  }

  /** 把 porcelain 的状态码翻成人话 */
  const GROUPS = [
    { key: "staged", label: "已暂存", match: (x, y) => x !== " " && x !== "?" },
    { key: "changed", label: "未暂存", match: (x, y) => y !== " " && x !== "?" },
    { key: "untracked", label: "未跟踪", match: (x) => x === "?" },
  ];

  function renderRows(rows) {
    if (rows.length === 0) {
      listEl.innerHTML = '<p class="empty"><b>工作区干净</b>没有未提交的改动</p>';
      return;
    }
    const parts = [];
    for (const group of GROUPS) {
      const items = rows.filter((row) => group.match(row.x, row.y));
      if (items.length === 0) continue;
      parts.push(`<div class="group">${group.label} · ${items.length}</div>`);
      for (const item of items) {
        const code = (item.x === "?" ? "?" : item.x !== " " ? item.x : item.y) || "M";
        parts.push(
          `<div class="row"><span class="code ${code}">${code}</span>` +
            `<span class="path" title="${escapeAttr(item.path)}">${escapeHtml(item.path)}</span></div>`,
        );
      }
    }
    listEl.innerHTML = parts.join("");
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

  async function refresh() {
    // 分支：detached HEAD 时 `--abbrev-ref` 返回 "HEAD"，换成短哈希更有用
    let branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "HEAD") {
      branch = (await git(["rev-parse", "--short", "HEAD"])) ?? "HEAD";
    }

    if (branch === null) {
      branchEl.textContent = "不是 Git 仓库";
      trackEl.textContent = "";
      listEl.innerHTML =
        '<p class="empty"><b>当前目录不是一个 Git 仓库</b>换到有 .git 的项目再看</p>';
      return;
    }
    branchEl.textContent = branch;

    /*
      领先/落后：没有 upstream 时这条命令会失败（退出码非 0）——
      那不是错误，只是"这个分支还没推过"，所以静默留空。
    */
    const track = await git(["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    if (track === null) {
      trackEl.textContent = "";
    } else {
      const [behind, ahead] = track.split(/\s+/).map((value) => Number.parseInt(value, 10) || 0);
      trackEl.textContent = `${ahead > 0 ? `↑${ahead}` : ""}${behind > 0 ? ` ↓${behind}` : ""}`.trim();
    }

    /*
      `-z` 用 NUL 分隔，比按换行切更稳 —— 文件名里可以有换行（虽然罕见），
      而按换行切会把一个文件拆成两条。`--porcelain=v1` 的前两列是 X/Y 状态码。
    */
    const status = await api.exec("git", ["status", "--porcelain=v1", "-z"]);
    if (status.code !== 0) {
      listEl.innerHTML = '<p class="empty"><b>读不到工作区状态</b>git status 失败了</p>';
      return;
    }
    const rows = status.stdout
      .split("\u0000")
      .filter((entry) => entry.length > 3)
      .map((entry) => ({ x: entry[0], y: entry[1], path: entry.slice(3) }));
    renderRows(rows);
  }

  let busy = false;
  async function safeRefresh() {
    // 上一轮还没跑完就跳过：切会话时可能连触发好几次，叠起来只会浪费
    if (busy) return;
    busy = true;
    try {
      await refresh();
    } catch (error) {
      // 失败**不静默**：把原因显示出来，否则面板会停在上一份数据上，
      // 而用户以为那是当前的
      listEl.innerHTML = `<p class="empty"><b>刷新失败</b>${escapeHtml(String(error))}</p>`;
    } finally {
      busy = false;
    }
  }

  refreshEl.addEventListener("click", () => void safeRefresh());
  /*
    **这里只订阅 theme。**

    `active` / `reload` / `config` 三个事件名在契约里是保留位：宿主今天不会推它们
    （见 shared/contracts/surface.ts 的说明）。这个文件原先订阅了 `active` ——
    那是一行**看着能用、永远不会触发**的代码，而它会被当成"面板激活时会刷新"的证据读，
    掩盖真正在起作用的是下面那个 5 秒轮询。

    面板也不缺它：切走时这个页面被卸载、切回来时重新加载（右栏只有常驻面板保持挂载），
    所以"切回来"本身就等于重新初始化。
  */
  api.on("theme", (payload) => applyTheme(typeof payload === "string" ? payload : api.info.theme));

  void safeRefresh();
  // 5 秒一次：够跟上"改了几个文件"，又不至于让 git 一直在跑
  setInterval(() => void safeRefresh(), 5000);
  api.ready().catch(() => {});
})();
