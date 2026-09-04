import {
  ExecutionError,
  FileError,
  err,
  ok,
  truncateTail,
  type Context,
  type ExecutionEnv,
  type FileInfo,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type ShellOutputTruncation,
} from "@earendil-works/pi-agent-core";

function toFileError(error: unknown, path?: string): FileError {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error : undefined;
  return new FileError("unknown", message, path, cause);
}

function normalizePath(input: string): string {
  const segments = input.replace(/\\/g, "/").split("/");
  const result: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      if (result.length === 0 && segment === "") result.push("");
      continue;
    }
    if (segment === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") result.pop();
      else result.push("..");
      continue;
    }
    result.push(segment);
  }
  return result.join("/") || "/";
}

export class ElectronExecutionEnv implements ExecutionEnv {
  cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd.replace(/\\/g, "/");
  }

  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    void context;
    const normalized = path.replace(/\\/g, "/");
    const isAbsolute = /^([a-zA-Z]:)?\//.test(normalized);
    return ok(normalizePath(isAbsolute ? normalized : `${this.cwd}/${normalized}`));
  }

  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    void context;
    return ok(normalizePath(parts.join("/")));
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    void context;
    try {
      return ok(await window.polaragent.fs.readFile(path));
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    void context;
    try {
      const lines = (await window.polaragent.fs.readFile(path)).split("\n");
      return ok(options?.maxLines != null ? lines.slice(0, options.maxLines) : lines);
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    void context;
    try {
      const base64 = await window.polaragent.fs.readBinaryFile(path);
      // base64 → Uint8Array
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return ok(bytes);
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    void context;
    try {
      if (typeof content !== "string") {
        return err(new FileError("not_supported", "仅支持写入文本内容", path));
      }
      // 安全说明：不传 securityMode 覆盖字段 —— AI 内部 harness 用 fs 与 shell
      // 必须走用户当前权限模式，绝不能自行升权到 full。参见 security.cjs。
      await window.polaragent.fs.writeFile(path, content);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    void context;
    try {
      if (typeof content !== "string") {
        return err(new FileError("not_supported", "仅支持追加文本内容", path));
      }
      await window.polaragent.fs.appendFile(path, content);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    void context;
    try {
      const info = await window.polaragent.fs.stat(path);
      const name = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
      return ok({
        name,
        path,
        kind: info.isDirectory ? "directory" : info.isSymlink ? "symlink" : "file",
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    void context;
    try {
      const base = path.replace(/\\/g, "/").replace(/\/$/, "");
      const entries = await window.polaragent.fs.listDirectoryEntries(path);
      return ok(
        entries.map((entry) => ({
          name: entry.name,
          path: `${base}/${entry.name}`,
          kind: entry.isDir ? "directory" : "file",
          size: 0,
          mtimeMs: 0,
        })),
      );
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.absolutePath(path, context);
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    void context;
    try {
      return ok(await window.polaragent.fs.exists(path));
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    void options;
    void context;
    try {
      await window.polaragent.fs.createDirectory(path);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, path));
    }
  }

  async remove(
    path: string,
    options: { force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    void context;
    try {
      await window.polaragent.fs.deletePath(path);
      return ok(undefined);
    } catch (error) {
      if (options?.force && !(await window.polaragent.fs.exists(path).catch(() => true))) return ok(undefined);
      return err(toFileError(error, path));
    }
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    void context;
    try {
      const dir = await window.polaragent.fs.createTempDir(prefix ?? "polaragent-");
      return ok(dir);
    } catch (error) {
      return err(toFileError(error));
    }
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    void context;
    try {
      const filePath = await window.polaragent.fs.createTempFile({
        prefix: options?.prefix ?? "",
        suffix: options?.suffix ?? "",
      });
      return ok(filePath);
    } catch (error) {
      return err(toFileError(error));
    }
  }

  async exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    try {
      // 安全说明：AI 内部 harness 执行 shell 命令不允许覆盖 securityMode。
      // 必须走用户当前权限模式，绝不能自行升权到 full。
      const result = await window.polaragent.shell.exec({
        command,
        cwd: options?.cwd ?? this.cwd,
        timeoutMs: options?.timeout ? options.timeout * 1000 : undefined,
      });
      if (result.blocked) {
        return err(new ExecutionError("unknown", `命令被安全策略拦截：${result.error ?? ""}`));
      }
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      const output = stdout + (stderr ? `\n${stderr}` : "");
      // 0.85.0：ShellExecResult 不再携带 stdout/stderr，输出改为经 onUpdate 流式交付，
      // 返回值只含 exitCode 与截断元数据。
      const truncated = truncateTail(output);
      const truncation: ShellOutputTruncation = {
        truncated: truncated.truncated,
        truncatedBy: truncated.truncatedBy,
        totalLines: truncated.totalLines,
        totalBytes: truncated.totalBytes,
        outputLines: truncated.outputLines,
        outputBytes: truncated.outputBytes,
        lastLinePartial: truncated.lastLinePartial,
        firstLineExceedsLimit: truncated.firstLineExceedsLimit,
        maxLines: truncated.maxLines,
        maxBytes: truncated.maxBytes,
      };
      if (options?.onUpdate) {
        options.onUpdate(
          { kind: "replace", output: { text: output, truncation } },
          context,
        );
      }
      return ok({
        exitCode: result.exitCode ?? -1,
        truncation,
      });
    } catch (error) {
      return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
    }
  }

  async renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    void context;
    try {
      await window.polaragent.fs.rename(sourcePath, destinationPath);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, sourcePath));
    }
  }

  async cleanup(context: Context): Promise<void> {
    void context;
  }
}
