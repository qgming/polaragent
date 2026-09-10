import { describe, expect, it } from "vitest";

import {
  buildCsp,
  classifyAppUi,
  isAllowedAppNavigation,
  isPermissionAllowed,
  isSafeExternalUrl,
} from "./session-security";

describe("classifyAppUi", () => {
  const dev = "http://127.0.0.1:1420";

  it("classifies vite dev server as dev", () => {
    expect(classifyAppUi("http://127.0.0.1:1420/src/main.tsx", dev)).toBe("dev");
  });

  it("classifies packaged dist as prod", () => {
    expect(classifyAppUi("file:///D:/app/dist/index.html")).toBe("prod");
  });

  it("treats office / unrelated urls as other", () => {
    expect(classifyAppUi("file:///C:/tmp/render.html", dev)).toBe("other");
    expect(classifyAppUi("https://example.com", dev)).toBe("other");
  });
});

describe("buildCsp", () => {
  it("returns empty string — CSP fully removed per product decision", () => {
    expect(buildCsp({ mode: "prod" })).toBe("");
    expect(buildCsp({ mode: "dev" })).toBe("");
  });
});

describe("permission whitelist", () => {
  it("allows media / clipboard-write / fullscreen only", () => {
    expect(isPermissionAllowed("media")).toBe(true);
    expect(isPermissionAllowed("clipboard-sanitized-write")).toBe(true);
    expect(isPermissionAllowed("fullscreen")).toBe(true);
    expect(isPermissionAllowed("geolocation")).toBe(false);
    expect(isPermissionAllowed("notifications")).toBe(false);
    expect(isPermissionAllowed("")).toBe(false);
  });
});

describe("isSafeExternalUrl", () => {
  it("accepts http and https only", () => {
    expect(isSafeExternalUrl("https://example.com/a")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
    expect(isSafeExternalUrl(undefined)).toBe(false);
  });
});

describe("isAllowedAppNavigation", () => {
  it("allows app ui origins and blocks others", () => {
    const dev = "http://127.0.0.1:1420";
    expect(isAllowedAppNavigation("http://127.0.0.1:1420/", dev)).toBe(true);
    expect(isAllowedAppNavigation("file:///D:/polaragent/dist/index.html", dev)).toBe(true);
    expect(isAllowedAppNavigation("https://evil.example", dev)).toBe(false);
  });
});
