# Finance log

Back to [Documentation Log](../log.md). Canonical page: [finance.md](../finance.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-10-02 | Phase 2 — Schema and repository parity: migration 37 (`add_finance_foundation`), `FinanceSqliteStore`/`FinanceMemoryStore`, the `AppRepository` finance methods (people, accounts, categories + default-taxonomy seed, rules, merchant memory, transactions/splits/transfers, import profiles/batches, transaction import with chunked inserts + dedupe + near-duplicate + whole-history transfer detection, undo, category suggestions), and the finance `AppSettings` flags | `docs/finance.md`, `docs/storage-and-backups.md` | Migration `add_finance_foundation`, `finance-sqlite-store.ts`, `finance-memory-store.ts`, `repository.contract.ts`'s `finance` block, issue #149 |
