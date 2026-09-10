import type { PolarAgentApi } from "@/shared/contracts/api";

declare global {
  interface Window {
    polaragent: PolarAgentApi;
  }
}
