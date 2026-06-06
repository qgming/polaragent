export function getElectronWindowApi() {
  return window.polaragent?.window ?? null;
}

export async function runWindowAction(
  action: (windowApi: NonNullable<typeof window.polaragent>["window"]) => Promise<void>,
) {
  const windowApi = getElectronWindowApi();
  if (!windowApi) return;
  await action(windowApi);
}

export async function refreshMaximizedState(setMaximized: (value: boolean) => void) {
  try {
    setMaximized((await window.polaragent?.window.isMaximized()) ?? false);
  } catch {
    setMaximized(false);
  }
}

export async function copyText(text: string) {
  if (!text || !navigator.clipboard) return;
  await navigator.clipboard.writeText(text);
}
