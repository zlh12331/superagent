// src/renderer/components/chat/attachments.ts
// 附件内容拼接（自 ChatInput 提取：file:read 拼装逻辑独立可测）
// ──────────────────────────────────────────────
// 附件以「文件名 + 代码块」形式拼进消息文本；file:read 支持 GBK 自动转码。
// 读取失败（二进制/超大/权限）跳过内容仅保留文件名标注，不阻断发送。
// ──────────────────────────────────────────────

/** 附件项（对齐参考项目 ChatInputAttachments） */
export interface ChatAttachment {
  /** 绝对路径（发送时 file:read 读取内容） */
  readonly path: string;
  /** 展示名称（路径 basename） */
  readonly name: string;
}

/** 附件内容读取上限（字符，超出截断避免消息膨胀） */
export const ATTACHMENT_MAX_CHARS = 4000;

/** 由路径派生展示名（basename，兼容 win32/posix 分隔符） */
export function attachmentName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 读取附件内容并拼接进消息文本
 *
 * 浏览器模式（window.api 缺失）或无附件时原样返回 baseText。
 */
export async function buildTextWithAttachments(
  baseText: string,
  attachments: readonly ChatAttachment[],
): Promise<string> {
  if (attachments.length === 0 || typeof window === 'undefined' || window.api === undefined) {
    return baseText;
  }
  let text = baseText;
  for (const att of attachments) {
    try {
      const response = await window.api.file.read({
        path: att.path,
        offset: undefined,
        limit: 200,
      });
      if ('error' in response && response.error !== undefined) {
        text += `\n\n[附件: ${att.name}]（内容读取失败）`;
        continue;
      }
      if ('data' in response && response.data !== undefined) {
        const content = response.data.content.slice(0, ATTACHMENT_MAX_CHARS);
        text += `\n\n[附件: ${att.name}]\n\`\`\`\n${content}\n\`\`\``;
      }
    } catch {
      // 读取失败（二进制文件/权限）：仅附加文件名标注，不阻断发送
      text += `\n\n[附件: ${att.name}]（内容读取失败）`;
    }
  }
  return text;
}
