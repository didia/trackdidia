//! Custom sqlite pool that replaces `tauri-plugin-sql`.
//!
//! `tauri-plugin-sql` 2.3.2 has no way to pin its pool to a single physical connection: its
//! `DbPool::connect` (src/wrapper.rs) calls `Pool::connect(conn_url)` with no `PoolOptions`
//! hook, and sqlx's default `max_connections` is 10. sqlx's idle connection queue is a FIFO
//! `crossbeam ArrayQueue` (sqlx-core-0.8.6/src/pool/inner.rs), not most-recently-used, so once
//! the app's own concurrent `db.select()` calls (e.g. the `Promise.all` in `getGtdOverview`)
//! grow the pool past one connection, a `BEGIN IMMEDIATE` and its later `COMMIT` -- issued as
//! separate `db.execute()` calls from the JS side -- can land on two different physical
//! connections. WAL mode and app-level write serialization do not close that hole by
//! themselves.
//!
//! This module builds our own `sqlx::SqlitePool` with `max_connections(1)` *and* the idle-timeout
//! and max-lifetime reapers disabled (see `build_pool_options` below -- capping `max_connections`
//! alone does not stop sqlx from silently closing that one connection between statements of an
//! open transaction), so there is structurally only one physical connection that stays open for
//! the app's lifetime: every statement, including BEGIN/COMMIT pairs, is guaranteed to hit it. It
//! is exposed to the frontend as three thin Tauri commands
//! (`db_connect`, `db_execute`, `db_select`) that mirror the shape of the plugin's own
//! `load`/`execute`/`select` commands closely enough that the TS-side `Database` wrapper in
//! `tauri-sqlite-repository.ts` is a drop-in replacement for `@tauri-apps/plugin-sql`'s.

use serde_json::Value as JsonValue;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteRow},
    Column, Executor, Pool, Row, Sqlite, TypeInfo, ValueRef,
};
use tauri::{async_runtime::Mutex, AppHandle, Manager, State};

/// Holds the single-connection pool once `db_connect` has run. `None` before the frontend's
/// first `getDb()` call.
#[derive(Default)]
pub struct DbState(Mutex<Option<Pool<Sqlite>>>);

type SqlxQuery<'q> = sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>;

/// Binds a JSON value coming from the JS side onto a query, mirroring the conversion rules
/// `tauri-plugin-sql` used (src/wrapper.rs `DbPool::execute`/`select`): null binds as SQL NULL,
/// strings bind as TEXT, numbers bind as REAL (sqlite's column affinity then coerces to
/// INTEGER/TEXT as declared by the schema). Only null/string/number ever flow through this
/// repository's params (booleans are converted to 0/1 integers before being passed in), but
/// bool/object/array are handled defensively rather than panicking.
fn bind_value<'q>(query: SqlxQuery<'q>, value: JsonValue) -> SqlxQuery<'q> {
    match value {
        JsonValue::Null => query.bind(None::<String>),
        JsonValue::String(text) => query.bind(text),
        JsonValue::Number(number) => query.bind(number.as_f64().unwrap_or_default()),
        JsonValue::Bool(flag) => query.bind(if flag { 1_i64 } else { 0_i64 }),
        other => query.bind(other.to_string()),
    }
}

/// Decodes a single column into a `serde_json::Value`, based on sqlite's runtime type name for
/// that value (mirrors `tauri-plugin-sql`'s src/decode/sqlite.rs, minus the DATE/TIME/DATETIME
/// branches this schema never uses -- every column here is TEXT, INTEGER or REAL).
fn column_to_json(row: &SqliteRow, index: usize) -> Result<JsonValue, String> {
    let raw = row
        .try_get_raw(index)
        .map_err(|error| format!("Impossible de lire la colonne SQLite: {error}"))?;

    if raw.is_null() {
        return Ok(JsonValue::Null);
    }

    let type_name = raw.type_info().name().to_ascii_uppercase();
    let value = match type_name.as_str() {
        "TEXT" => row
            .try_get::<String, _>(index)
            .map(JsonValue::String)
            .unwrap_or(JsonValue::Null),
        "INTEGER" | "NUMERIC" => row
            .try_get::<i64, _>(index)
            .map(|value| JsonValue::Number(value.into()))
            .unwrap_or(JsonValue::Null),
        "REAL" => row
            .try_get::<f64, _>(index)
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        "BLOB" => row
            .try_get::<Vec<u8>, _>(index)
            .map(|bytes| {
                JsonValue::Array(bytes.into_iter().map(|byte| JsonValue::Number(byte.into())).collect())
            })
            .unwrap_or(JsonValue::Null),
        _ => row
            .try_get::<String, _>(index)
            .map(JsonValue::String)
            .unwrap_or(JsonValue::Null),
    };

    Ok(value)
}

/// Builds the `SqlitePoolOptions` shared by `db_connect` and the test suite below.
///
/// `max_connections(1)` alone is not sufficient to guarantee a `BEGIN IMMEDIATE` / `COMMIT`
/// pair issued as separate statements lands on the same physical connection: sqlx returns the
/// connection to its idle queue after every individual statement (sqlx-core-0.8.6
/// `pool/connection.rs::return_to_pool`), and that same code path closes the connection if it is
/// `is_beyond_max_lifetime` (default 30 minutes) even while a transaction is open-but-idle
/// between statements. Separately, a background maintenance task (sqlx-core-0.8.6
/// `pool/inner.rs`) wakes every `min(max_lifetime, idle_timeout)` (default `idle_timeout` is 10
/// minutes) and closes idle connections past either threshold. Either reaper closing the
/// connection mid-transaction silently rolls it back; the later `COMMIT` then runs against a
/// freshly-opened connection in autocommit mode and fails (swallowed by `rollbackQuietly` on the
/// TS side), defeating the whole point of pinning the pool to one connection.
///
/// So, in addition to `max_connections(1)`, this disables both reapers (`idle_timeout(None)`,
/// `max_lifetime(None)`) and keeps the connection warm (`min_connections(1)`) so the single
/// connection is never closed out from under an open transaction for the app's lifetime.
fn build_pool_options() -> SqlitePoolOptions {
    SqlitePoolOptions::new()
        .max_connections(1)
        .min_connections(1)
        .idle_timeout(None)
        .max_lifetime(None)
}

/// Resolves a `sqlite:<file>` connection string to a full path under `app_data_dir`, matching
/// the directory `resolve_storage_paths` (main.rs) already reports/backs up, so the live
/// connection always points at the same file shown to the user in Settings.
fn resolve_db_path(app: &AppHandle, db: &str) -> Result<std::path::PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Impossible de resoudre app_data_dir: {error}"))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|error| format!("Impossible de creer le dossier de donnees: {error}"))?;

    let file_name = db.split_once(':').map(|(_, rest)| rest).unwrap_or(db);
    Ok(app_data_dir.join(file_name))
}

/// Connects the single-connection pool once (subsequent calls are no-ops), mirroring
/// `@tauri-apps/plugin-sql`'s `Database.load`.
#[tauri::command]
pub async fn db_connect(app: AppHandle, state: State<'_, DbState>, db: String) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Ok(());
    }

    let db_path = resolve_db_path(&app, &db)?;
    let connect_options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true);

    // The whole point: max_connections(1) means there is only ever one physical connection, so
    // BEGIN IMMEDIATE / COMMIT pairs issued as separate statements are structurally guaranteed
    // to hit the same connection -- but only because build_pool_options() *also* disables the
    // idle-timeout and max-lifetime reapers (see its doc comment); max_connections(1) alone does
    // not stop sqlx from closing that one connection out from under an open transaction.
    let pool = build_pool_options()
        .connect_with(connect_options)
        .await
        .map_err(|error| format!("Connexion SQLite impossible: {error}"))?;

    *guard = Some(pool);
    Ok(())
}

/// Pool-level implementation of `db_execute`, factored out so both the Tauri command and the
/// tests below (which build a pool directly with `build_pool_options`, bypassing `AppHandle`/
/// `State`) exercise the exact same query/bind/decode path.
async fn execute_on_pool(pool: &Pool<Sqlite>, query: &str, values: Vec<JsonValue>) -> Result<(u64, i64), String> {
    let mut sql_query = sqlx::query(query);
    for value in values {
        sql_query = bind_value(sql_query, value);
    }

    let result = pool
        .execute(sql_query)
        .await
        .map_err(|error| format!("Echec de la requete SQLite: {error}"))?;

    Ok((result.rows_affected(), result.last_insert_rowid()))
}

/// Pool-level implementation of `db_select`, factored out for the same reason as
/// `execute_on_pool`.
async fn select_on_pool(
    pool: &Pool<Sqlite>,
    query: &str,
    values: Vec<JsonValue>,
) -> Result<Vec<serde_json::Map<String, JsonValue>>, String> {
    let mut sql_query = sqlx::query(query);
    for value in values {
        sql_query = bind_value(sql_query, value);
    }

    let rows = pool
        .fetch_all(sql_query)
        .await
        .map_err(|error| format!("Echec de la requete SQLite: {error}"))?;

    let mut results = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut object = serde_json::Map::new();
        for (index, column) in row.columns().iter().enumerate() {
            object.insert(column.name().to_string(), column_to_json(row, index)?);
        }
        results.push(object);
    }

    Ok(results)
}

/// Executes a non-SELECT statement, mirroring `@tauri-apps/plugin-sql`'s `execute` command:
/// returns `(rows_affected, last_insert_rowid)`.
#[tauri::command]
pub async fn db_execute(state: State<'_, DbState>, query: String, values: Vec<JsonValue>) -> Result<(u64, i64), String> {
    let guard = state.0.lock().await;
    let pool = guard
        .as_ref()
        .ok_or_else(|| "Base de donnees SQLite non initialisee".to_string())?;

    execute_on_pool(pool, &query, values).await
}

/// Executes a SELECT statement, mirroring `@tauri-apps/plugin-sql`'s `select` command: returns
/// one JSON object per row, keyed by column name.
#[tauri::command]
pub async fn db_select(
    state: State<'_, DbState>,
    query: String,
    values: Vec<JsonValue>,
) -> Result<Vec<serde_json::Map<String, JsonValue>>, String> {
    let guard = state.0.lock().await;
    let pool = guard
        .as_ref()
        .ok_or_else(|| "Base de donnees SQLite non initialisee".to_string())?;

    select_on_pool(pool, &query, values).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Builds a pool with the exact same options `db_connect` uses (`build_pool_options`),
    /// pointed at a tempfile-backed sqlite database rather than `:memory:`. A tempfile is more
    /// faithful to the real bug: sqlite's `:memory:` databases are private per-connection unless
    /// a shared-cache URI is used, which would mask exactly the kind of "statement landed on a
    /// different physical connection" bug this whole module exists to prevent.
    async fn test_pool() -> (Pool<Sqlite>, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("create tempdir");
        let db_path = dir.path().join("test.db");
        let connect_options = SqliteConnectOptions::new().filename(&db_path).create_if_missing(true);

        let pool = build_pool_options()
            .connect_with(connect_options)
            .await
            .expect("connect to tempfile sqlite db");

        (pool, dir)
    }

    /// (a) Round-trips NULL/TEXT/INTEGER/REAL through `bind_value` + `column_to_json`.
    #[tokio::test]
    async fn bind_and_decode_round_trip_all_value_types() {
        let (pool, _dir) = test_pool().await;

        execute_on_pool(
            &pool,
            "CREATE TABLE round_trip (id INTEGER PRIMARY KEY, text_col TEXT, int_col INTEGER, real_col REAL)",
            vec![],
        )
        .await
        .expect("create table");

        execute_on_pool(
            &pool,
            "INSERT INTO round_trip (id, text_col, int_col, real_col) VALUES (?, ?, ?, ?)",
            vec![json!(1), json!("hello"), json!(42), json!(3.5)],
        )
        .await
        .expect("insert row with values");

        execute_on_pool(
            &pool,
            "INSERT INTO round_trip (id, text_col, int_col, real_col) VALUES (?, ?, ?, ?)",
            vec![json!(2), JsonValue::Null, JsonValue::Null, JsonValue::Null],
        )
        .await
        .expect("insert row with nulls");

        let rows = select_on_pool(&pool, "SELECT * FROM round_trip ORDER BY id", vec![])
            .await
            .expect("select rows back");

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["text_col"], json!("hello"));
        assert_eq!(rows[0]["int_col"], json!(42));
        assert_eq!(rows[0]["real_col"], json!(3.5));
        assert_eq!(rows[1]["text_col"], JsonValue::Null);
        assert_eq!(rows[1]["int_col"], JsonValue::Null);
        assert_eq!(rows[1]["real_col"], JsonValue::Null);
    }

    /// (b) `rows_affected`/`last_insert_rowid` are correct after an INSERT.
    #[tokio::test]
    async fn execute_returns_rows_affected_and_last_insert_rowid() {
        let (pool, _dir) = test_pool().await;

        execute_on_pool(&pool, "CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)", vec![])
            .await
            .expect("create table");

        let (rows_affected, last_insert_rowid) =
            execute_on_pool(&pool, "INSERT INTO items (name) VALUES (?)", vec![json!("first")])
                .await
                .expect("insert first row");
        assert_eq!(rows_affected, 1);
        assert_eq!(last_insert_rowid, 1);

        let (rows_affected, last_insert_rowid) =
            execute_on_pool(&pool, "INSERT INTO items (name) VALUES (?)", vec![json!("second")])
                .await
                .expect("insert second row");
        assert_eq!(rows_affected, 1);
        assert_eq!(last_insert_rowid, 2);
    }

    /// (c) The actual regression this round is about: BEGIN IMMEDIATE / INSERT / COMMIT issued
    /// as three SEPARATE calls through the pool (mirroring the three separate `db_execute`
    /// invocations the JS side makes) must land on the same connection and commit successfully.
    #[tokio::test]
    async fn separate_begin_insert_commit_calls_persist_the_row() {
        let (pool, _dir) = test_pool().await;

        execute_on_pool(&pool, "CREATE TABLE txn_commit (id INTEGER PRIMARY KEY, name TEXT)", vec![])
            .await
            .expect("create table");

        execute_on_pool(&pool, "BEGIN IMMEDIATE", vec![]).await.expect("begin immediate");
        execute_on_pool(&pool, "INSERT INTO txn_commit (id, name) VALUES (?, ?)", vec![json!(1), json!("alice")])
            .await
            .expect("insert inside transaction");
        execute_on_pool(&pool, "COMMIT", vec![]).await.expect("commit");

        let rows = select_on_pool(&pool, "SELECT * FROM txn_commit", vec![])
            .await
            .expect("select after commit");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], json!("alice"));
    }

    /// Mirror of the above with ROLLBACK: the row must NOT be persisted.
    #[tokio::test]
    async fn separate_begin_insert_rollback_calls_discard_the_row() {
        let (pool, _dir) = test_pool().await;

        execute_on_pool(&pool, "CREATE TABLE txn_rollback (id INTEGER PRIMARY KEY, name TEXT)", vec![])
            .await
            .expect("create table");

        execute_on_pool(&pool, "BEGIN IMMEDIATE", vec![]).await.expect("begin immediate");
        execute_on_pool(&pool, "INSERT INTO txn_rollback (id, name) VALUES (?, ?)", vec![json!(1), json!("bob")])
            .await
            .expect("insert inside transaction");
        execute_on_pool(&pool, "ROLLBACK", vec![]).await.expect("rollback");

        let rows = select_on_pool(&pool, "SELECT * FROM txn_rollback", vec![])
            .await
            .expect("select after rollback");
        assert!(rows.is_empty());
    }

    // (d)/(e) below directly demonstrate the fix by forcing sqlx's idle-timeout reaper to close
    // the connection between the BEGIN IMMEDIATE and COMMIT calls: sqlx's background maintenance
    // task wakes every `min(max_lifetime, idle_timeout)` -- derived from the pool's OWN configured
    // options, not a fixed interval (sqlx-core-0.8.6 `pool/inner.rs` around line 508) -- so a test
    // pool can simply configure a short `idle_timeout` (here, 50ms) to make the reaper fire in well
    // under a second. No sleeping past real (minutes-long) reaper intervals and no reaching into
    // sqlx-internal pool state is needed; a prior version of this comment claimed otherwise, which
    // was wrong.

    /// Same shape as `test_pool`, but deliberately WITHOUT the reap-prevention
    /// `build_pool_options` provides: `min_connections(0)` and a short `idle_timeout` so the
    /// background reaper can (and, per (d) below, does) close the single connection while a
    /// transaction sits open-but-idle between statements.
    async fn reaper_prone_test_pool() -> (Pool<Sqlite>, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("create tempdir");
        let db_path = dir.path().join("test.db");
        let connect_options = SqliteConnectOptions::new().filename(&db_path).create_if_missing(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .min_connections(0)
            .idle_timeout(std::time::Duration::from_millis(50))
            .max_lifetime(None)
            .connect_with(connect_options)
            .await
            .expect("connect to tempfile sqlite db");

        (pool, dir)
    }

    /// (d) Negative control: with the reaper enabled (short `idle_timeout`, no
    /// `min_connections(1)`/`idle_timeout(None)` protection), a BEGIN IMMEDIATE followed by a
    /// sleep long enough for the reaper to run, then an INSERT and a COMMIT -- each issued as a
    /// SEPARATE `execute_on_pool` call, exactly as real `db_execute` invocations from the JS side
    /// are -- silently loses the transaction: the reaper closes the idle connection during the
    /// sleep, the INSERT runs in autocommit on a freshly-opened connection, and COMMIT fails
    /// because there is no transaction left to commit. This is the exact failure
    /// `build_pool_options`'s `idle_timeout(None)`/`max_lifetime(None)`/`min_connections(1)` exist
    /// to prevent, and the exact failure `rollbackQuietly` would swallow in production.
    #[tokio::test(flavor = "multi_thread")]
    async fn reaper_without_protection_silently_breaks_an_open_transaction() {
        let (pool, _dir) = reaper_prone_test_pool().await;

        execute_on_pool(&pool, "CREATE TABLE txn_reaped (id INTEGER PRIMARY KEY, name TEXT)", vec![])
            .await
            .expect("create table");

        execute_on_pool(&pool, "BEGIN IMMEDIATE", vec![]).await.expect("begin immediate");

        // Long enough for the 50ms idle_timeout reaper to wake up and close the idle connection.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        execute_on_pool(&pool, "INSERT INTO txn_reaped (id, name) VALUES (?, ?)", vec![json!(1), json!("carol")])
            .await
            .expect("insert (runs in autocommit on a fresh connection once reaped)");

        let commit_result = execute_on_pool(&pool, "COMMIT", vec![]).await;
        assert!(
            commit_result.is_err(),
            "expected COMMIT to fail because the reaper closed the connection mid-transaction, got {commit_result:?}"
        );
    }

    /// (e) Same sequence as (d), but through a pool built with the real `build_pool_options()`
    /// (the config `db_connect` actually uses in production): the reaper is disabled, so the
    /// connection survives the sleep, COMMIT succeeds, and the row is durably persisted.
    #[tokio::test(flavor = "multi_thread")]
    async fn build_pool_options_protects_an_open_transaction_from_the_reaper() {
        let (pool, _dir) = test_pool().await;

        execute_on_pool(&pool, "CREATE TABLE txn_protected (id INTEGER PRIMARY KEY, name TEXT)", vec![])
            .await
            .expect("create table");

        execute_on_pool(&pool, "BEGIN IMMEDIATE", vec![]).await.expect("begin immediate");

        // Same sleep as (d); with build_pool_options() the reaper never fires, so this is inert.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        execute_on_pool(&pool, "INSERT INTO txn_protected (id, name) VALUES (?, ?)", vec![json!(1), json!("carol")])
            .await
            .expect("insert inside transaction");

        execute_on_pool(&pool, "COMMIT", vec![]).await.expect("commit should succeed: no reaper interfered");

        let rows = select_on_pool(&pool, "SELECT * FROM txn_protected", vec![])
            .await
            .expect("select after commit");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], json!("carol"));
    }
}
