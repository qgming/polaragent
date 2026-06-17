// 全局错误边界
// src/components/ErrorBoundary.tsx

import React, { Component, ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { withTranslation, type WithTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundaryComponent extends Component<Props & WithTranslation<"common">, State> {
  constructor(props: Props & WithTranslation<"common">) {
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
    const { t } = this.props;
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-background p-8">
          <div className="max-w-md text-center">
            <div className="mb-6 flex justify-center">
              <div className="flex size-16 items-center justify-center rounded-full bg-red-500/10">
                <AlertCircle className="size-8 text-red-500" />
              </div>
            </div>

	            <h1 className="mb-2 text-2xl font-bold">{t("errorBoundary.title")}</h1>
	            <p className="mb-6 text-sm text-muted-foreground">
	              {t("errorBoundary.description")}
	            </p>

            {this.state.error && (
              <div className="mb-6 rounded-lg bg-muted p-4 text-left">
                <p className="text-xs font-mono text-red-600 dark:text-red-400">
                  {this.state.error.message}
                </p>
              </div>
            )}

	            <Button onClick={this.handleReset}>{t("errorBoundary.reload")}</Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export const ErrorBoundary = withTranslation("common")(ErrorBoundaryComponent);
