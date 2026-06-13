// 系统信息工具 —— system_info
// src/ai/tools/system-info.ts
//
// 获取电脑的系统信息，包括时间、位置、硬件、网络等。
// 为 AI 提供上下文感知能力，无需通过 bash 命令间接获取。

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { text, type ToolContext } from "./tool-context";

// system_info 参数 schema
const systemInfoParams = Type.Object({
  categories: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("time"),        // 时间信息
        Type.Literal("location"),    // 位置信息
        Type.Literal("system"),      // 系统信息
        Type.Literal("hardware"),    // 硬件信息
        Type.Literal("network"),     // 网络信息
        Type.Literal("environment"), // 环境信息
        Type.Literal("gps"),         // GPS 定位信息
        Type.Literal("all"),         // 所有信息（不包含 GPS）
      ]),
      {
        description:
          "要获取的信息类别。可选值：time(时间)、location(位置)、system(系统)、hardware(硬件)、network(网络)、environment(环境)、gps(GPS定位)、all(全部，不含GPS)。默认为 all。",
      },
    ),
  ),
  gpsTimeout: Type.Optional(
    Type.Number({
      description: "GPS 定位超时时间（毫秒），默认 10000（10秒）",
      minimum: 1000,
      maximum: 30000,
    }),
  ),
});

type SystemInfoParams = Static<typeof systemInfoParams>;

// 时间信息
interface TimeInfo {
  timestamp: number;
  iso: string;
  local: string;
  timezone: string;
  timezoneOffset: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: string;
}

// 位置信息
interface LocationInfo {
  timezone: string;
  timezoneOffset: number;
  language: string;
  locale: string;
}

// 系统信息
interface SystemInfo {
  platform: string;
  platformVersion?: string;
  arch: string;
  hostname?: string;
  userAgent: string;
  cores: number;
  memory: {
    total: number;
    available: number;
    percentage: number;
  };
}

// 硬件信息
interface HardwareInfo {
  cores: number;
  memory: {
    total: number;
    totalGB: string;
  };
  screen: {
    width: number;
    height: number;
    colorDepth: number;
    pixelRatio: number;
  };
}

// 网络信息
interface NetworkInfo {
  online: boolean;
  connectionType?: string;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}

// 环境信息
interface EnvironmentInfo {
  workingDirectory?: string;
  userLanguage: string;
  userLanguages: string[];
}

// GPS 定位信息
interface GpsInfo {
  latitude: number;
  longitude: number;
  accuracy: number; // 精度（米）
  altitude?: number | null; // 海拔（米）
  altitudeAccuracy?: number | null; // 海拔精度（米）
  heading?: number | null; // 方向（度，0-360，0=正北）
  speed?: number | null; // 速度（米/秒）
  timestamp: number; // 定位时间戳
}

// GPS 错误信息
interface GpsError {
  code: number;
  message: string;
  permissionDenied: boolean;
  positionUnavailable: boolean;
  timeout: boolean;
}

// 获取时间信息
function getTimeInfo(): TimeInfo {
  const now = new Date();
  const days = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  return {
    timestamp: now.getTime(),
    iso: now.toISOString(),
    local: now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: -now.getTimezoneOffset() / 60,
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
    second: now.getSeconds(),
    dayOfWeek: days[now.getDay()],
  };
}

// 获取位置信息
function getLocationInfo(): LocationInfo {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -new Date().getTimezoneOffset() / 60;

  return {
    timezone: timeZone,
    timezoneOffset: offset,
    language: navigator.language,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  };
}

// 获取系统信息
function getSystemInfo(): SystemInfo {
  const memory = (performance as any).memory;

  return {
    platform: navigator.platform,
    arch: navigator.userAgent.includes("x64") || navigator.userAgent.includes("WOW64") ? "x64" : "x86",
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency || 1,
    memory: memory
      ? {
          total: memory.jsHeapSizeLimit,
          available: memory.jsHeapSizeLimit - memory.usedJSHeapSize,
          percentage: Math.round((memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100),
        }
      : {
          total: 0,
          available: 0,
          percentage: 0,
        },
  };
}

// 获取硬件信息
function getHardwareInfo(): HardwareInfo {
  const memory = (performance as any).memory;
  const totalMemory = memory?.jsHeapSizeLimit || 0;

  return {
    cores: navigator.hardwareConcurrency || 1,
    memory: {
      total: totalMemory,
      totalGB: (totalMemory / (1024 ** 3)).toFixed(2) + " GB",
    },
    screen: {
      width: screen.width,
      height: screen.height,
      colorDepth: screen.colorDepth,
      pixelRatio: window.devicePixelRatio || 1,
    },
  };
}

// 获取网络信息
function getNetworkInfo(): NetworkInfo {
  const nav = navigator as any;
  const connection = nav.connection || nav.mozConnection || nav.webkitConnection;

  return {
    online: navigator.onLine,
    connectionType: connection?.type,
    effectiveType: connection?.effectiveType,
    downlink: connection?.downlink,
    rtt: connection?.rtt,
  };
}

// 获取环境信息
function getEnvironmentInfo(ctx: ToolContext): EnvironmentInfo {
  return {
    workingDirectory: ctx.workingDir,
    userLanguage: navigator.language,
    userLanguages: navigator.languages ? Array.from(navigator.languages) : [navigator.language],
  };
}

// 获取 GPS 定位信息
function getGpsInfo(timeoutMs: number = 10000): Promise<GpsInfo | GpsError> {
  return new Promise((resolve) => {
    // 检查浏览器是否支持 Geolocation API
    if (!navigator.geolocation) {
      resolve({
        code: -1,
        message: "浏览器不支持 Geolocation API",
        permissionDenied: false,
        positionUnavailable: true,
        timeout: false,
      });
      return;
    }

    // 获取当前位置
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coords = position.coords;
        resolve({
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
          altitude: coords.altitude,
          altitudeAccuracy: coords.altitudeAccuracy,
          heading: coords.heading,
          speed: coords.speed,
          timestamp: position.timestamp,
        });
      },
      (error) => {
        resolve({
          code: error.code,
          message: error.message,
          permissionDenied: error.code === 1, // PERMISSION_DENIED
          positionUnavailable: error.code === 2, // POSITION_UNAVAILABLE
          timeout: error.code === 3, // TIMEOUT
        });
      },
      {
        enableHighAccuracy: true, // 启用高精度模式
        timeout: timeoutMs,
        maximumAge: 0, // 不使用缓存
      },
    );
  });
}

// 格式化输出
function formatOutput(data: any, categories: string[]): string {
  const sections: string[] = [];

  if (categories.includes("time") || categories.includes("all")) {
    const time = data.time as TimeInfo;
    sections.push(
      "## ⏰ 时间信息\n" +
        `- 当前时间: ${time.local}\n` +
        `- ISO 格式: ${time.iso}\n` +
        `- 时间戳: ${time.timestamp}\n` +
        `- 时区: ${time.timezone} (UTC${time.timezoneOffset >= 0 ? "+" : ""}${time.timezoneOffset})\n` +
        `- 日期: ${time.year}年${time.month}月${time.day}日 ${time.dayOfWeek}\n` +
        `- 时刻: ${time.hour}:${String(time.minute).padStart(2, "0")}:${String(time.second).padStart(2, "0")}`,
    );
  }

  if (categories.includes("location") || categories.includes("all")) {
    const loc = data.location as LocationInfo;
    sections.push(
      "## 📍 位置信息\n" +
        `- 时区: ${loc.timezone}\n` +
        `- UTC 偏移: ${loc.timezoneOffset >= 0 ? "+" : ""}${loc.timezoneOffset} 小时\n` +
        `- 语言: ${loc.language}\n` +
        `- 区域: ${loc.locale}`,
    );
  }

  if (categories.includes("system") || categories.includes("all")) {
    const sys = data.system as SystemInfo;
    sections.push(
      "## 💻 系统信息\n" +
        `- 平台: ${sys.platform}\n` +
        `- 架构: ${sys.arch}\n` +
        `- CPU 核心数: ${sys.cores}\n` +
        `- 内存使用: ${sys.memory.percentage}% (可用: ${(sys.memory.available / (1024 ** 2)).toFixed(0)} MB)`,
    );
  }

  if (categories.includes("hardware") || categories.includes("all")) {
    const hw = data.hardware as HardwareInfo;
    sections.push(
      "## 🖥️ 硬件信息\n" +
        `- CPU 核心: ${hw.cores} 核\n` +
        `- 总内存: ${hw.memory.totalGB}\n` +
        `- 屏幕分辨率: ${hw.screen.width} × ${hw.screen.height}\n` +
        `- 色深: ${hw.screen.colorDepth} bit\n` +
        `- 像素比: ${hw.screen.pixelRatio}`,
    );
  }

  if (categories.includes("network") || categories.includes("all")) {
    const net = data.network as NetworkInfo;
    sections.push(
      "## 🌐 网络信息\n" +
        `- 在线状态: ${net.online ? "✅ 在线" : "❌ 离线"}\n` +
        `- 连接类型: ${net.connectionType || "未知"}\n` +
        `- 有效类型: ${net.effectiveType || "未知"}\n` +
        `- 下行速度: ${net.downlink ? net.downlink + " Mbps" : "未知"}\n` +
        `- 延迟 (RTT): ${net.rtt ? net.rtt + " ms" : "未知"}`,
    );
  }

  if (categories.includes("environment") || categories.includes("all")) {
    const env = data.environment as EnvironmentInfo;
    sections.push(
      "## 📁 环境信息\n" +
        `- 工作目录: ${env.workingDirectory || "未设置"}\n` +
        `- 用户语言: ${env.userLanguage}\n` +
        `- 支持语言: ${env.userLanguages.join(", ")}`,
    );
  }

  if (categories.includes("gps")) {
    const gps = data.gps;
    if (gps) {
      if ("code" in gps) {
        // GPS 错误
        const error = gps as GpsError;
        let errorMsg = "## 📍 GPS 定位\n";
        if (error.permissionDenied) {
          errorMsg += "❌ 定位失败：用户拒绝了位置权限请求\n";
          errorMsg += "- 提示：请在浏览器设置中允许位置访问";
        } else if (error.positionUnavailable) {
          errorMsg += "❌ 定位失败：无法获取位置信息\n";
          errorMsg += `- 原因：${error.message}\n`;
          errorMsg += "- 提示：请确保设备有 GPS 模块或网络连接";
        } else if (error.timeout) {
          errorMsg += "⏱️ 定位超时：未能在指定时间内获取位置\n";
          errorMsg += "- 提示：请尝试增加超时时间或移动到开阔区域";
        } else {
          errorMsg += `❌ 定位失败：${error.message}`;
        }
        sections.push(errorMsg);
      } else {
        // GPS 成功
        const info = gps as GpsInfo;
        let gpsText = "## 📍 GPS 定位\n";
        gpsText += `- 经度: ${info.longitude.toFixed(6)}°\n`;
        gpsText += `- 纬度: ${info.latitude.toFixed(6)}°\n`;
        gpsText += `- 精度: ${info.accuracy.toFixed(0)} 米\n`;
        if (info.altitude !== null && info.altitude !== undefined) {
          gpsText += `- 海拔: ${info.altitude.toFixed(1)} 米\n`;
        }
        if (info.altitudeAccuracy !== null && info.altitudeAccuracy !== undefined) {
          gpsText += `- 海拔精度: ${info.altitudeAccuracy.toFixed(0)} 米\n`;
        }
        if (info.heading !== null && info.heading !== undefined) {
          gpsText += `- 方向: ${info.heading.toFixed(0)}° (0°=正北)\n`;
        }
        if (info.speed !== null && info.speed !== undefined) {
          gpsText += `- 速度: ${(info.speed * 3.6).toFixed(1)} km/h\n`;
        }
        gpsText += `- 定位时间: ${new Date(info.timestamp).toLocaleString("zh-CN")}`;
        sections.push(gpsText);
      }
    }
  }

  return sections.join("\n\n");
}

export function systemInfoTool(ctx: ToolContext): AgentTool<typeof systemInfoParams> {
  return {
    name: "system_info",
    label: "系统信息",
    description:
      "获取电脑的系统信息，包括当前时间、时区、位置、硬件配置、网络状态、GPS 定位等。" +
      "支持 GPS 定位（需要用户授权）：经纬度、精度、海拔、速度、方向等信息。" +
      "可用于时间感知、地理位置判断、系统兼容性检查等场景。",
    parameters: systemInfoParams,
    execute: async (_id, params: SystemInfoParams) => {
      try {
        const categories = params.categories || ["all"];
        const hasAll = categories.includes("all");
        const gpsTimeout = params.gpsTimeout || 10000;

        const data: any = {};

        if (hasAll || categories.includes("time")) {
          data.time = getTimeInfo();
        }

        if (hasAll || categories.includes("location")) {
          data.location = getLocationInfo();
        }

        if (hasAll || categories.includes("system")) {
          data.system = getSystemInfo();
        }

        if (hasAll || categories.includes("hardware")) {
          data.hardware = getHardwareInfo();
        }

        if (hasAll || categories.includes("network")) {
          data.network = getNetworkInfo();
        }

        if (hasAll || categories.includes("environment")) {
          data.environment = getEnvironmentInfo(ctx);
        }

        // GPS 定位是异步的，且需要用户授权，所以只在明确请求时获取
        if (categories.includes("gps")) {
          data.gps = await getGpsInfo(gpsTimeout);
        }

        const formattedOutput = formatOutput(data, categories);

        return {
          content: text(formattedOutput),
          details: data,
        };
      } catch (error) {
        return {
          content: text(
            `获取系统信息失败：${error instanceof Error ? error.message : String(error)}`,
          ),
          details: { error: String(error) },
        };
      }
    },
  };
}
