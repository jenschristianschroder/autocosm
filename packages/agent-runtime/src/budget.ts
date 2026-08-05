import { z } from 'zod';

/**
 * Cost controls for AI decisions.
 *
 * Every one of these is a hard bound, not a hint. The world must stay affordable when it is left
 * running unattended, so the think job refuses work rather than exceeding a budget.
 */
export const DecisionBudgetSchema = z.object({
  /** Proposals a single job execution may obtain before it stops and exits. */
  maxDecisionsPerRun: z.number().int().min(0).max(500).default(12),
  /** Proposals the whole world may obtain in one UTC day across all executions. */
  maxDecisionsPerDay: z.number().int().min(0).max(50_000).default(600),
  /** Minimum logical ticks between two AI decisions for the same lineage. */
  minTicksBetweenLineageDecisions: z.number().int().min(0).max(10_000).default(20),
  /** Wall-clock budget for one proposal. */
  perDecisionTimeoutMs: z.number().int().min(250).max(120_000).default(20_000),
  /** Wall-clock budget for the whole execution, leaving the rest for the next run. */
  runBudgetMs: z.number().int().min(1_000).max(600_000).default(90_000),
  /** Attempts per decision before it is marked failed and left to the heuristic policy. */
  maxAttemptsPerDecision: z.number().int().min(1).max(10).default(3),
  maxCompletionTokens: z.number().int().min(32).max(4_096).default(320),
});

export type DecisionBudget = z.infer<typeof DecisionBudgetSchema>;

export const DEFAULT_DECISION_BUDGET: DecisionBudget = DecisionBudgetSchema.parse({});

/** Tracks consumption inside one execution so limits are enforced, not merely declared. */
export class BudgetLedger {
  readonly #budget: DecisionBudget;
  readonly #startedAtEpochMs: number;
  readonly #now: () => number;
  #usedThisRun = 0;
  #usedToday: number;
  readonly #lastDecisionTickByLineage = new Map<string, number>();

  constructor(
    budget: DecisionBudget,
    options: {
      usedToday?: number;
      lastDecisionTickByLineage?: ReadonlyMap<string, number>;
      now?: () => number;
    } = {},
  ) {
    this.#budget = budget;
    this.#now = options.now ?? Date.now;
    this.#startedAtEpochMs = this.#now();
    this.#usedToday = options.usedToday ?? 0;
    for (const [lineageId, tick] of options.lastDecisionTickByLineage ?? []) {
      this.#lastDecisionTickByLineage.set(lineageId, tick);
    }
  }

  get usedThisRun(): number {
    return this.#usedThisRun;
  }

  get remainingThisRun(): number {
    return Math.max(0, this.#budget.maxDecisionsPerRun - this.#usedThisRun);
  }

  /** Why the ledger refuses, or `undefined` when the decision may proceed. */
  refusalFor(lineageId: string, tick: number): BudgetRefusal | undefined {
    if (this.#usedThisRun >= this.#budget.maxDecisionsPerRun) return 'runLimit';
    if (this.#usedToday >= this.#budget.maxDecisionsPerDay) return 'dailyLimit';
    if (this.#now() - this.#startedAtEpochMs >= this.#budget.runBudgetMs) return 'timeBudget';
    const last = this.#lastDecisionTickByLineage.get(lineageId);
    if (last !== undefined && tick - last < this.#budget.minTicksBetweenLineageDecisions) {
      return 'lineageCooldown';
    }
    return undefined;
  }

  /** Record a consumed decision. Called only after a proposal attempt actually happened. */
  consume(lineageId: string, tick: number): void {
    this.#usedThisRun += 1;
    this.#usedToday += 1;
    this.#lastDecisionTickByLineage.set(lineageId, tick);
  }

  /** True when nothing further can be attempted in this execution, so the job should exit. */
  exhausted(): boolean {
    return (
      this.#usedThisRun >= this.#budget.maxDecisionsPerRun ||
      this.#usedToday >= this.#budget.maxDecisionsPerDay ||
      this.#now() - this.#startedAtEpochMs >= this.#budget.runBudgetMs
    );
  }
}

export type BudgetRefusal = 'runLimit' | 'dailyLimit' | 'timeBudget' | 'lineageCooldown';
