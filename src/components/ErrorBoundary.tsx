// 全局错误边界
// src/components/ErrorBoundary.tsx

import React, { Component, ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

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
      return (
        <div className="flex h-screen items-center justify-center bg-background p-8">
          <div className="max-w-md text-center">
            <div className="mb-6 flex justify-center">
              <div className="flex size-16 items-center justify-center rounded-full bg-red-500/10">
                <AlertCircle className="size-8 text-red-500" />
              </div>
            </div>

            <h1 className="mb-2 text-2xl font-bold">出错了</h1>
            <p className="mb-6 text-sm text-muted-foreground">
              应用遇到了一个意外错误。请尝试刷新页面。
            </p>

            {this.state.error && (
              <div className="mb-6 rounded-lg bg-muted p-4 text-left">
                <p className="text-xs font-mono text-red-600 dark:text-red-400">
                  {this.state.error.message}
                </p>
              </div>
            )}

            <Button onClick={this.handleReset}>刷新页面</Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
