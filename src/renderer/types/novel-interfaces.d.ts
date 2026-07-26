// src/renderer/types/novel-interfaces.d.ts
// Novel 写作域数据接口 — 全局可用的 ambient 声明
// 本文件不含 import/export，所有接口全局可见

interface NovelProject {
  id: string;
  title: string;
  author: string;
  genre: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

interface NovelChapter {
  id: string;
  volumeId: string;
  title: string;
  sortOrder: number;
  content: string;
  wordCount: number;
  summary: string;
  status: 'draft' | 'reviewed' | 'published';
  createdAt: string;
  updatedAt: string;
}

interface NovelVolume {
  id: string;
  projectId: string;
  title: string;
  sortOrder: number;
  summary: string;
  createdAt: string;
}

interface NovelChapterVolume extends NovelVolume {
  chapters: NovelChapter[];
}

interface OutlineItem {
  id: string;
  projectId: string;
  parentId: string | null;
  level: 'volume' | 'chapter' | 'scene';
  title: string;
  sortOrder: number;
  summary: string;
  targetWordCount: number;
  emotionalGoal: string;
  pacing: string;
  createdAt: string;
  updatedAt: string;
}

interface CharacterData {
  id: string;
  projectId: string;
  name: string;
  aliases: string[];
  role: string;
  appearance: string;
  personality: string;
  background: string;
  abilities: string;
  status: Record<string, string>;
  avatarUrl: string;
  createdAt: string;
  updatedAt: string;
}

interface WorldSetting {
  id: string;
  projectId: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface ReviewReport {
  overallScore: number;
  dimensions: Array<{
    name: string;
    score: number;
    maxScore: number;
    comment: string;
  }>;
  issues: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low';
    category: string;
    description: string;
    suggestion: string;
    location?: { chapterId: string; line?: number };
  }>;
  summary: string;
}
