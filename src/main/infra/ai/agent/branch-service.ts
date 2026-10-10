export type BranchClassification =
  | 'ordinary'
  | 'rewind-descendant'
  | 'rewind-sibling'
  | 'mixed-rewind';

export interface BranchRecord {
  readonly turnId: string;
  readonly parentTurnId: string | null;
  readonly classification: BranchClassification;
  readonly createdAt: number;
}

export interface BranchClassifyInput {
  readonly parentTurnId: string | null;
  readonly branchPointHasSibling?: boolean;
  readonly multipleRewinds?: boolean;
}

export function classifyBranch(input: BranchClassifyInput): BranchClassification {
  if (input.multipleRewinds === true) {
    return 'mixed-rewind';
  }
  if (input.parentTurnId === null) {
    return 'ordinary';
  }
  return input.branchPointHasSibling === true ? 'rewind-sibling' : 'rewind-descendant';
}

export class BranchService {
  private readonly branchesBySession = new Map<string, BranchRecord[]>();

  record(sessionId: string, turnId: string, parentTurnId: string | null): BranchClassification {
    const records = this.branchesBySession.get(sessionId) ?? [];
    const classification = classifyBranch({
      parentTurnId,
      branchPointHasSibling:
        parentTurnId !== null && records.some((r) => r.parentTurnId === parentTurnId),
    });
    records.push({ turnId, parentTurnId, classification, createdAt: Date.now() });
    this.branchesBySession.set(sessionId, records);
    return classification;
  }

  list(sessionId: string): BranchRecord[] {
    return this.branchesBySession.get(sessionId) ?? [];
  }

  summary(sessionId: string): Array<{ parentTurnId: string; count: number }> {
    const records = this.list(sessionId);
    const byParent = new Map<string, number>();
    for (const record of records) {
      if (record.parentTurnId !== null) {
        byParent.set(record.parentTurnId, (byParent.get(record.parentTurnId) ?? 0) + 1);
      }
    }
    return [...byParent.entries()]
      .map(([parentTurnId, count]) => ({ parentTurnId, count }))
      .sort((a, b) => b.count - a.count);
  }

  clear(sessionId: string): void {
    this.branchesBySession.delete(sessionId);
  }
}
