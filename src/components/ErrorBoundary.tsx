// 全局错误边界
// src/components/ErrorBoundary.tsx

import React, { Component, ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import i18n from "@/i18n";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * 错误边界组件（Class Component）
 * 注意：不使用 withTranslation HOC，因为 React 19 + StrictMode 下可能在 i18n 未就绪时触发渲染。
 * 直接使用 i18n.t() 降级方案，确保错误边界本身不会因翻译系统问题而崩溃。
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("错误边界捕获到错误:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      // 使用 i18n.t() 而不是 useTranslation hook（Class Component 不支持 hooks）
      // 如果 i18n 未初始化，使用硬编码的中文降级文案
      const t = (key: string, fallback: string) => {
        try {
          return i18n.isInitialized ? i18n.t(key) : fallback;
        } catch {
          return fallback;
        }
      };

      return (
        <div className="flex h-screen items-center justify-center bg-background p-8">
          <div className="max-w-md text-center">
            <div className="mb-6 flex justify-center">
              <div className="flex size-16 items-center justify-center rounded-full bg-red-500/10">
                <AlertCircle className="size-8 text-red-500" />
              </div>
            </div>

            <h1 className="mb-2 text-2xl font-bold">
              {t("errorBoundary.title", "出错了")}
            </h1>
            <p className="mb-6 text-sm text-muted-foreground">
              {t("errorBoundary.description", "应用遇到了一个意外错误。请尝试刷新页面。")}
            </p>

            {this.state.error && (
              <div className="mb-6 rounded-lg bg-muted p-4 text-left">
                <p className="text-xs font-mono text-red-600 dark:text-red-400">
                  {this.state.error.message}
                </p>
              </div>
            )}

            <Button onClick={this.handleReset}>
              {t("errorBoundary.reload", "刷新页面")}
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
