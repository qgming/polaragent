import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import { GeneralPanel } from "./GeneralPanel";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  const settings: Settings = {
    theme: "light",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    services: [],
    defaultModel: null,
    thinkingLevel: "medium",
    permissionMode: "default",
    agentMode: "standard",
    disabledSkillNames: [],
    disabledSubagentNames: [],
    mcpServers: [],
    systemMcpServerEnabled: {},
    webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
  };
  useSettingsStore.setState({ settings, loaded: true });
  vi.stubGlobal("oint", { settings: { write: vi.fn(async () => undefined) } });
});

describe("goal continuation setting", () => {
  it("offers only the two execution modes and keeps goal settings independent", async () => {
    render(<GeneralPanel />);
    const modes = within(screen.getByRole("group", { name: "默认模式" }));
    expect(modes.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "默认",
      "编排",
    ]);
    expect(modes.queryByRole("button", { name: "目标" })).toBeNull();
    fireEvent.click(modes.getByRole("button", { name: "编排" }));
    await waitFor(() =>
      expect(window.oint.settings.write).toHaveBeenCalledWith(
        expect.objectContaining({ agentMode: "orchestrate" }),
      ),
    );
    expect(screen.getByRole("spinbutton", { name: "目标自动续行上限" })).toBeDefined();
  });

  it.each([
    ["200", 100],
    ["0", 1],
    ["7.9", 7],
  ])("clamps %s to %s when saved", async (value, expected) => {
    render(<GeneralPanel />);
    const input = screen.getByRole("spinbutton", { name: "目标自动续行上限" });
    fireEvent.change(input, { target: { value } });
    expect(window.oint.settings.write).not.toHaveBeenCalled();
    fireEvent.blur(input);
    await waitFor(() =>
      expect(window.oint.settings.write).toHaveBeenCalledWith(
        expect.objectContaining({ goalContinuationLimit: expected }),
      ),
    );
  });

  it("keeps the default on empty input and reports a failed save", async () => {
    render(<GeneralPanel />);
    const input = screen.getByRole("spinbutton", { name: "目标自动续行上限" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("10");
    expect(window.oint.settings.write).not.toHaveBeenCalled();
    vi.mocked(window.oint.settings.write).mockRejectedValueOnce(new Error("disk full"));
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    await waitFor(() => expect(input.value).toBe("10"));
  });
});
