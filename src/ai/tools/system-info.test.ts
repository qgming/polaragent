// 系统信息工具测试
// src/ai/tools/system-info.test.ts

import { describe, it, expect } from "vitest";
import { systemInfoTool } from "./system-info";
import type { ToolContext } from "./tool-context";

describe("systemInfoTool", () => {
  const mockContext: ToolContext = {
    threadId: "test-thread",
    workingDir: "d:/dev/polaragent",
    permissionMode: "full",
  };

  it("应该返回所有系统信息（默认 all）", async () => {
    const tool = systemInfoTool(mockContext);
    const result = await tool.execute("test-id", {});

    expect(result.content).toBeDefined();
    const textContent = result.content.find((c) => c.type === "text");
    expect(textContent).toBeDefined();
    if (textContent?.type === "text") {
      expect(textContent.text).toContain("⏰ 时间信息");
      expect(textContent.text).toContain("📍 位置信息");
      expect(textContent.text).toContain("💻 系统信息");
      expect(textContent.text).toContain("🖥️ 硬件信息");
      expect(textContent.text).toContain("🌐 网络信息");
      expect(textContent.text).toContain("📁 环境信息");
    }

    expect(result.details).toHaveProperty("time");
    expect(result.details).toHaveProperty("location");
    expect(result.details).toHaveProperty("system");
    expect(result.details).toHaveProperty("hardware");
    expect(result.details).toHaveProperty("network");
    expect(result.details).toHaveProperty("environment");
  });

  it("应该只返回时间信息", async () => {
    const tool = systemInfoTool(mockContext);
    const result = await tool.execute("test-id", { categories: ["time"] });

    const textContent = result.content.find((c) => c.type === "text");
    if (textContent?.type === "text") {
      expect(textContent.text).toContain("⏰ 时间信息");
      expect(textContent.text).not.toContain("📍 位置信息");
    }
    expect(result.details).toHaveProperty("time");
    expect(result.details).not.toHaveProperty("location");
  });

  it("应该返回多个指定类别的信息", async () => {
    const tool = systemInfoTool(mockContext);
    const result = await tool.execute("test-id", {
      categories: ["time", "network"],
    });

    const textContent = result.content.find((c) => c.type === "text");
    if (textContent?.type === "text") {
      expect(textContent.text).toContain("⏰ 时间信息");
      expect(textContent.text).toContain("🌐 网络信息");
      expect(textContent.text).not.toContain("📍 位置信息");
    }
    expect(result.details).toHaveProperty("time");
    expect(result.details).toHaveProperty("network");
    expect(result.details).not.toHaveProperty("location");
  });

  it("时间信息应该包含正确的字段", async () => {
    const tool = systemInfoTool(mockContext);
    const result = await tool.execute("test-id", { categories: ["time"] });

    const timeInfo = result.details.time;
    expect(timeInfo).toHaveProperty("timestamp");
    expect(timeInfo).toHaveProperty("iso");
    expect(timeInfo).toHaveProperty("local");
    expect(timeInfo).toHaveProperty("timezone");
    expect(timeInfo).toHaveProperty("year");
    expect(timeInfo).toHaveProperty("month");
    expect(timeInfo).toHaveProperty("day");
    expect(timeInfo).toHaveProperty("dayOfWeek");
    expect(typeof timeInfo.timestamp).toBe("number");
    expect(timeInfo.timestamp).toBeGreaterThan(0);
  });

  it("位置信息应该包含时区", async () => {
    const tool = systemInfoTool(mockContext);
    const result = await tool.execute("test-id", { categories: ["location"] });

    const locationInfo = result.details.location;
    expect(locationInfo).toHaveProperty("timezone");
    expect(locationInfo).toHaveProperty("timezoneOffset");
    expect(locationInfo).toHaveProperty("language");
    expect(typeof locationInfo.timezone).toBe("string");
  });

  it("系统信息应该包含平台和架构", async () => {
    const tool = systemInfoTool(mockContext);
    const result = await tool.execute("test-id", { categories: ["system"] });

    const systemInfo = result.details.system;
    expect(systemInfo).toHaveProperty("platform");
    expect(systemInfo).toHaveProperty("arch");
    expect(systemInfo).toHaveProperty("cores");
    expect(systemInfo.cores).toBeGreaterThan(0);
  });

  it("硬件信息应该包含屏幕分辨率", async () => {
    const tool = systemInfoTool(mockContext);
    const result = await tool.execute("test-id", { categories: ["hardware"] });

    const hardwareInfo = result.details.hardware;
    expect(hardwareInfo).toHaveProperty("screen");
    expect(hardwareInfo.screen).toHaveProperty("width");
    expect(hardwareInfo.screen).toHaveProperty("height");
    expect(hardwareInfo.screen.width).toBeGreaterThan(0);
    expect(hardwareInfo.screen.height).toBeGreaterThan(0);
  });

  it("网络信息应该包含在线状态", async () => {
    const tool = systemInfoTool(mockContext);
    const result = await tool.execute("test-id", { categories: ["network"] });

    const networkInfo = result.details.network;
    expect(networkInfo).toHaveProperty("online");
    expect(typeof networkInfo.online).toBe("boolean");
  });

  it("环境信息应该包含工作目录", async () => {
    const tool = systemInfoTool(mockContext);
    const result = await tool.execute("test-id", { categories: ["environment"] });

    const envInfo = result.details.environment;
    expect(envInfo).toHaveProperty("workingDirectory");
    expect(envInfo.workingDirectory).toBe("d:/dev/polaragent");
    expect(envInfo).toHaveProperty("userLanguage");
  });

  it("工具元数据应该正确", () => {
    const tool = systemInfoTool(mockContext);
    expect(tool.name).toBe("system_info");
    expect(tool.label).toBe("系统信息");
    expect(tool.description).toContain("获取电脑的系统信息");
  });
});
