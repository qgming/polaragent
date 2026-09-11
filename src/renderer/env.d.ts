import type { OintApi } from "@/shared/contracts/api";

declare global {
  interface Window {
    oint: OintApi;
  }
}
