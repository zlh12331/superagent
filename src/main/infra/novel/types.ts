// src/main/infra/novel/types.ts
// 共享类型定义

export type WritingStyle = 'modern' | 'classical' | 'light' | 'heavy';

export type ExpandDirection = 'detail' | 'background' | 'emotion' | 'dialogue';

export interface ContinueWritingParams {
  projectId: string;
  chapterId: string;
  context: string;
  style?: WritingStyle;
  length?: number;
}

export interface ExpandWritingParams {
  projectId: string;
  chapterId: string;
  selectedText: string;
  direction?: ExpandDirection;
}

export interface PolishWritingParams {
  projectId: string;
  chapterId: string;
  selectedText: string;
}

export interface RewriteWritingParams {
  projectId: string;
  chapterId: string;
  selectedText: string;
  style: WritingStyle;
}

export interface WritingResult {
  content: string;
  wordCount: number;
}

export interface ReviewChapterParams {
  content: string;
  chapterTitle?: string;
}

export interface ReviewReport {
  dimensions: Array<{
    name: string;
    score: number;
    comment: string;
  }>;
  issues: Array<{
    severity: string;
    description: string;
    suggestion: string;
  }>;
  overallScore: number;
  overallComment: string;
}

export interface GetInspirationParams {
  projectId: string;
  chapterId: string;
  context: string;
}

export interface InspirationSuggestion {
  title: string;
  description: string;
  example: string;
}

// ── 数据层共享类型 ──────────────────────────

import type {
  CharacterRelationshipRow,
} from '../storage/schema';

/** 角色关系详情（含角色名） */
export interface CharacterRelationshipDetail extends CharacterRelationshipRow {
  characterAName: string;
  characterBName: string;
}

/** 导出格式 */
export interface ExportResult {
  content: string;
  fileName: string;
}

/**
 * 强制类型转换（绕开 strict TS 约束）
 */
export function cast<T>(input: unknown): T {
  return input as T;
}

/**
 * 从未知对象安全获取字符串字段
 */
export function getStr(input: unknown, key: string): string {
  const obj = input as Record<string, unknown>;
  const val = obj[key];
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return '';
}

/**
 * 更新 payload 辅助（用于 partial update 场景）
 */
export function updPayload<T extends Record<string, unknown>>(
  input: unknown,
): Partial<T> {
  return input as Partial<T>;
}
