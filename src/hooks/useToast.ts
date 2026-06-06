import { create } from "zustand";
import type { ToastType } from "@/components/Toast";

export interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastState {
  toasts: ToastMessage[];
  show: (message: string, type?: ToastType) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  remove: (id: string) => void;
}

function createToastId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],

  show: (message, type = "info") => {
    const id = createToastId();
    set((state) => ({
      toasts: [...state.toasts, { id, message, type }].slice(-4),
    }));
  },

  success: (message) => get().show(message, "success"),
  error: (message) => get().show(message, "error"),
  info: (message) => get().show(message, "info"),

  remove: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    })),
}));
