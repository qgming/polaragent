// 投票创建器 - 用户手动发起投票
// src/components/VoteCreator.tsx

import { Plus, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface VoteCreatorProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (topic: string, options: Array<{ id: string; label: string }>) => void;
}

export function VoteCreator({ open, onClose, onSubmit }: VoteCreatorProps) {
  const [topic, setTopic] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);

  const handleAddOption = () => {
    setOptions([...options, ""]);
  };

  const handleRemoveOption = (index: number) => {
    if (options.length <= 2) return; // 最少保留2个选项
    setOptions(options.filter((_, i) => i !== index));
  };

  const handleOptionChange = (index: number, value: string) => {
    const newOptions = [...options];
    newOptions[index] = value;
    setOptions(newOptions);
  };

  const handleSubmit = () => {
    const trimmedTopic = topic.trim();
    const trimmedOptions = options.map((o) => o.trim()).filter(Boolean);

    if (!trimmedTopic) {
      alert("请输入投票主题");
      return;
    }

    if (trimmedOptions.length < 2) {
      alert("至少需要 2 个选项");
      return;
    }

    const formattedOptions = trimmedOptions.map((label, idx) => ({
      id: `option_${idx}`,
      label,
    }));

    onSubmit(trimmedTopic, formattedOptions);

    // 重置表单
    setTopic("");
    setOptions(["", ""]);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>发起投票</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* 投票主题 */}
          <div>
            <label className="mb-2 block text-sm font-medium">
              投票主题 <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例如：选择技术方案"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
            />
          </div>

          {/* 投票选项 */}
          <div>
            <label className="mb-2 block text-sm font-medium">
              投票选项 <span className="text-muted-foreground">(至少2个)</span>
            </label>
            <div className="space-y-2">
              {options.map((option, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={option}
                    onChange={(e) => handleOptionChange(index, e.target.value)}
                    placeholder={`选项 ${index + 1}`}
                    className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
                  />
                  {options.length > 2 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemoveOption(index)}
                      className="size-8 shrink-0"
                    >
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>

            {options.length < 6 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddOption}
                className="mt-2"
              >
                <Plus className="mr-1 size-3.5" />
                添加选项
              </Button>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleSubmit}>发起投票</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
