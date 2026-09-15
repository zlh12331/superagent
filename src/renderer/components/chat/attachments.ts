// src/renderer/components/chat/attachments.ts
// 附件内容拼接（自 ChatInput 提取：file:read 拼装逻辑独立可测）
// ──────────────────────────────────────────────
// 附件以「文件名 + 代码块」形式拼进消息文本；file:read 支持 GBK 自动转码。
// 读取失败（二进制/超大/权限）跳过内容仅保留文件名标注，不阻断发送。
// ──────────────────────────────────────────────

import { ATTACHMENT_MAX_CHARS as SHARED_ATTACHMENT_MAX_CHARS } from '@code-agent/shared/renderer';

import { unwrap } from '@/lib/ipc';

/** 附件项（对齐参考项目 ChatInputAttachments） */
export interface ChatAttachment {
  /** 绝对路径（发送时 file:read 读取内容） */
  readonly path: string;
  /** 展示名称（路径 basename） */
  readonly name: string;
}

/** 附件内容读取上限（字符；对齐 shared 单一真源 ATTACHMENT_MAX_CHARS=4000） */
export const ATTACHMENT_MAX_CHARS = SHARED_ATTACHMENT_MAX_CHARS;
/** 附件读取行数上限（file.read 的 limit 语义为行数：先限行读取，再按字符截断） */
const ATTACHMENT_READ_LINES = 200;

/** 由路径派生展示名（basename，兼容 win32/posix 分隔符） */
export function attachmentName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 读取附件内容并拼接进消息文本
 *
 * 浏览器模式（window.api 缺失）或无附件时原样返回 baseText。
 * label 传入 i18n 化的文案工厂（随界面语言）——此前硬编码中文会进入
 * 消息内容与模型上下文，且为 check:i18n 门禁盲区。
 */
export async function buildTextWithAttachments(
  baseText: string,
  attachments: readonly ChatAttachment[],
  label: {
    readonly attached: (name: string) => string;
    readonly readFailed: (name: string) => string;
  },
): Promise<string> {
  if (attachments.length === 0 || typeof window === 'undefined' || window.api === undefined) {
    return baseText;
  }
  let text = baseText;
  for (const att of attachments) {
    try {
      const data = unwrap(
        await window.api.file.read({
          path: att.path,
          offset: undefined,
          limit: ATTACHMENT_READ_LINES,
        }),
      );
      const content = data.content.slice(0, ATTACHMENT_MAX_CHARS);
      text += `\n\n${label.attached(att.name)}\n\`\`\`\n${content}\n\`\`\``;
    } catch {
      // 读取失败（二进制/权限/错误响应）：仅附加文件名标注，不阻断发送
      text += `\n\n${label.readFailed(att.name)}`;
    }
  }
  return text;
}
