# Finance log

Back to [Documentation Log](../log.md). Canonical page: [finance.md](../finance.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-10-03 | PR review fixes: all finance writers share the repository queue; undo checks every account in a batch and preserves user-categorized partners; transfer detection receives stored group ids; `all_matching` corrections are user-owned; splits are validated, atomic, and restore a category when cleared; archive reassigns splits/memory; migration 38 persists import-profile separators | `docs/finance.md`, `docs/storage-and-backups.md` | `finance-sqlite-store.ts`, `finance-memory-store.ts`, `splits.ts`, `repository.contract.ts` |
| 2026-10-02 | Phase 2 — Schema and repository parity: migration 37 (`add_finance_foundation`), `FinanceSqliteStore`/`FinanceMemoryStore`, the `AppRepository` finance methods (people, accounts, categories + default-taxonomy seed, rules, merchant memory, transactions/splits/transfers, import profiles/batches, transaction import with chunked inserts + dedupe + near-duplicate + whole-history transfer detection, undo, category suggestions), and the finance `AppSettings` flags | `docs/finance.md`, `docs/storage-and-backups.md` | Migration `add_finance_foundation`, `finance-sqlite-store.ts`, `finance-memory-store.ts`, `repository.contract.ts`'s `finance` block, issue #149 |
