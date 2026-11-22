import type { Platform, Fund, Transaction, DcaPlan, Settings } from '../types';
import * as storage from './storage';

/**
 * 一次写盘的结果。
 *
 * `ok:false` 时 `key` 指出失败的是哪个数据域（platforms / funds / …），
 * `rolledBack` 说明已写入的部分是否已经恢复成旧值。
 */
export type WriteResult =
  | { ok: true }
  | { ok: false; reason: 'write-failed'; key: string; rolledBack: boolean };

/**
 * 一次提交要落盘的**财务关键**数据。
 *
 * 派生数据（快照 / 净值历史 / 指数 / 备份时间戳）**不在这里**：
 * 它们写失败只是缓存没更新，下次刷新会补上，不影响账本正确性。
 * 这个区分原本靠 storage 里「返回 boolean vs 返回 void」表达，
 * 现在收进这个接口——调用方只能整体提交，不能自己拼。
 */
export interface LedgerState {
  platforms?: Platform[];
  funds?: Fund[];
  transactions?: Transaction[];
  dcaPlans?: DcaPlan[];
  settings?: Settings;
}

interface CommitStep {
  /** 数据域名（用于报错定位） */
  key: keyof LedgerState;
  /** 写这个 key */
  write: () => boolean;
  /** 回滚：把它恢复成提交前的旧值 */
  restore: () => void;
}

/**
 * 按固定顺序生成写入步骤。顺序固定 → 失败时能确定性地回滚。
 *
 * 旧实现在 removeFund 里靠「先写最大的那份，让配额不足时它先失败」来避免
 * 半套状态——但 funds 其实是最小的（transactions 才是最大且无上限增长），
 * 前提是反的。改成「写失败就回滚已写的 key」之后，不再需要猜哪个最大。
 */
function buildSteps(next: LedgerState): CommitStep[] {
  const steps: CommitStep[] = [];

  if (next.platforms !== undefined) {
    const value = next.platforms;
    const prev = storage.getPlatforms();
    steps.push({
      key: 'platforms',
      write: () => storage.savePlatforms(value),
      restore: () => { storage.savePlatforms(prev); },
    });
  }

  if (next.funds !== undefined) {
    const value = next.funds;
    const prev = storage.getFunds();
    steps.push({
      key: 'funds',
      write: () => storage.saveFunds(value),
      restore: () => { storage.saveFunds(prev); },
    });
  }

  if (next.transactions !== undefined) {
    const value = next.transactions;
    const prev = storage.getTransactions();
    steps.push({
      key: 'transactions',
      write: () => storage.saveTransactions(value),
      restore: () => { storage.saveTransactions(prev); },
    });
  }

  if (next.dcaPlans !== undefined) {
    const value = next.dcaPlans;
    const prev = storage.getDcaPlans();
    steps.push({
      key: 'dcaPlans',
      write: () => storage.saveDcaPlans(value),
      restore: () => { storage.saveDcaPlans(prev); },
    });
  }

  if (next.settings !== undefined) {
    const value = next.settings;
    const prev = storage.getSettings();
    steps.push({
      key: 'settings',
      write: () => storage.saveSettings(value),
      restore: () => { storage.saveSettings(prev); },
    });
  }

  return steps;
}

/**
 * **唯一的写盘入口**（财务关键数据）。
 *
 * 不变式：要么全部写成功（磁盘 = 新值），要么一个都没改成（磁盘 = 旧值）。
 * 调用方据此决定要不要更新内存状态——CLAUDE.md 的「写盘失败 = 不改内存状态」
 * 原本靠 12 处 store action 各自复制一遍，现在只在这里实现一次。
 *
 * 回滚本身也可能失败（配额一直不够）。那种情况下磁盘处于半套状态，
 * `rolledBack:false` 会如实报出来——宁可让调用方知道，也不假装没事。
 */
export function commitLedger(next: LedgerState): WriteResult {
  const steps = buildSteps(next);
  const written: CommitStep[] = [];

  for (const step of steps) {
    if (!step.write()) {
      let rolledBack = true;
      for (const done of [...written].reverse()) {
        try {
          done.restore();
        } catch {
          rolledBack = false;
        }
      }
      if (!rolledBack) {
        console.error(
          `[commit] 写盘失败（${step.key}）且回滚不完整——磁盘可能处于半更新状态，请立即导出备份`
        );
      }
      return { ok: false, reason: 'write-failed', key: step.key, rolledBack };
    }
    written.push(step);
  }

  return { ok: true };
}
