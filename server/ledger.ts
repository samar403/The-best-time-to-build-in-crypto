import type { Block, LedgerEntry } from "../shared/types.js";
import { canonical, sha256 } from "../shared/crypto.js";

export const GENESIS_HASH = "0".repeat(64);

export function hashBlock(block: Omit<Block, "hash">): string {
  return sha256(
    canonical({
      height: block.height,
      prevHash: block.prevHash,
      timestamp: block.timestamp,
      intentId: block.intentId,
      memo: block.memo,
      entries: block.entries,
    }),
  );
}

export class LedgerError extends Error {}

/**
 * Double-entry ledger with a hash-chained journal ("flight recorder").
 * Every posting must balance, and every block commits to the one before it,
 * so any after-the-fact edit is detectable by re-hashing the chain.
 */
export class Ledger {
  readonly blocks: Block[] = [];
  readonly balances = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  balance(account: string): number {
    return this.balances.get(account) ?? 0;
  }

  /**
   * Post a balanced set of entries. Accounts other than `external:*` may not
   * go negative. Returns the appended block.
   */
  post(entries: LedgerEntry[], memo: string, intentId: string | null = null): Block {
    if (entries.length < 2) throw new LedgerError("a posting needs at least two entries");
    let debits = 0;
    let credits = 0;
    for (const e of entries) {
      if (!Number.isInteger(e.debit) || !Number.isInteger(e.credit) || e.debit < 0 || e.credit < 0) {
        throw new LedgerError("entries must be non-negative integers");
      }
      debits += e.debit;
      credits += e.credit;
    }
    if (debits !== credits) throw new LedgerError(`unbalanced posting: ${debits} != ${credits}`);

    const next = new Map<string, number>();
    for (const e of entries) {
      const current = next.get(e.account) ?? this.balance(e.account);
      next.set(e.account, current + e.credit - e.debit);
    }
    for (const [account, value] of next) {
      if (value < 0 && !account.startsWith("external:")) {
        throw new LedgerError(`insufficient funds in ${account}`);
      }
    }

    const prev = this.blocks[this.blocks.length - 1];
    const draft: Omit<Block, "hash"> = {
      height: this.blocks.length,
      prevHash: prev ? prev.hash : GENESIS_HASH,
      timestamp: this.now(),
      intentId,
      memo,
      entries,
    };
    const block: Block = { ...draft, hash: hashBlock(draft) };
    this.blocks.push(block);
    for (const [account, value] of next) this.balances.set(account, value);
    return block;
  }

  /** Move `amount` from one account to another (plus optional fee to a fee account). */
  transfer(from: string, to: string, amount: number, memo: string, intentId: string | null = null, fee?: { account: string; amount: number }): Block {
    const feeAmount = fee?.amount ?? 0;
    const entries: LedgerEntry[] = [
      { account: from, debit: amount, credit: 0 },
      { account: to, debit: 0, credit: amount - feeAmount },
    ];
    if (fee && feeAmount > 0) entries.push({ account: fee.account, debit: 0, credit: feeAmount });
    return this.post(entries, memo, intentId);
  }
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  brokenAt: number | null;
  reason: string | null;
}

/** Re-hash every block and check the links. */
export function verifyChain(blocks: Block[]): ChainVerification {
  let prevHash = GENESIS_HASH;
  for (const block of blocks) {
    if (block.prevHash !== prevHash) {
      return { valid: false, checked: block.height, brokenAt: block.height, reason: "prevHash does not match previous block" };
    }
    const { hash, ...rest } = block;
    if (hashBlock(rest) !== hash) {
      return { valid: false, checked: block.height, brokenAt: block.height, reason: "block contents do not match its hash" };
    }
    const debits = block.entries.reduce((s, e) => s + e.debit, 0);
    const credits = block.entries.reduce((s, e) => s + e.credit, 0);
    if (debits !== credits) {
      return { valid: false, checked: block.height, brokenAt: block.height, reason: "unbalanced entries" };
    }
    prevHash = hash;
  }
  return { valid: true, checked: blocks.length, brokenAt: null, reason: null };
}
