import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "@/renderer/stores/ui-store";
import { FileViewer } from "./file-viewer";
import { PanelEmpty } from "./panel-view";

/**
 * 单文件查看器面板：对话里点一张文件卡片后进的那一屏。
 *
 * 这一层现在只做两件事：把「看哪个文件」从 store 里取出来，以及没有目标时的空态。
 * **「这个文件怎么读」全部在 FileViewer 里** —— 它与文件面板的预览共用同一份实现
 *（渲染 / 原始两档、markdown 排版、代码高亮、原文编辑与保存）。
 *
 * 两处仍然各有一个面板而不是合成一个，是因为**导航模型**不同：文件面板是「从根目录
 * 逐层点进去」的浏览，标题左边有返回、有一整条路径痕；而这里是从对话里点一张卡片直达
 * 一个文件，没有来路可退（用户要的是「看这个文件」，不是「顺便逛一下它所在的目录」）。
 * 所以返回按钮由各自的调用方交给 FileViewer 的 `leading` 插槽，这里不给。
 */
export function FileViewPanel(): React.JSX.Element {
  const { t } = useTranslation();
  const target = useUiStore((s) => s.filePanelTarget);

  if (target === null) {
    return <PanelEmpty icon={FileText} title={t("rightPanel.fileEmpty")} />;
  }

  return <FileViewer path={target} />;
}
