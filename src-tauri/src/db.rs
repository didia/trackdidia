//! Single-connection SQLite pool, exposed as `db_connect` / `db_execute` / `db_select`.
//!
//! JS issues `BEGIN` / `COMMIT` as separate commands, so the pool must keep one physical
//! connection for the app's lifetime. See `build_pool_options`.

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

/// Binds a JSON value from the JS side onto a query. Null → SQL NULL, strings → TEXT,
/// numbers → REAL (column affinity then coerces). Bools become 0/1; other JSON types
/// stringify. The repository only sends null/string/number in practice.
fn bind_value<'q>(query: SqlxQuery<'q>, value: JsonValue) -> SqlxQuery<'q> {
    match value {
        JsonValue::Null => query.bind(None::<String>),
        JsonValue::String(text) => query.bind(text),
        JsonValue::Number(number) => query.bind(number.as_f64().unwrap_or_default()),
        JsonValue::Bool(flag) => query.bind(if flag { 1_i64 } else { 0_i64 }),
        other => query.bind(other.to_string()),
    }
}

/// Decodes a column into JSON from sqlite's runtime type. Schema columns are TEXT, INTEGER,
/// or REAL; DATE/TIME branches are omitted.
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

/// Pool options shared by `db_connect` and the tests below.
///
/// `max_connections(1)` is not enough: sqlx can still close that connection between
/// statements of an open transaction via idle-timeout / max-lifetime reapers. Disabling
/// both and keeping `min_connections(1)` leaves one connection alive for the app lifetime.
fn build_pool_options() -> SqlitePoolOptions {
    SqlitePoolOptions::new()
        .max_connections(1)
        .min_connections(1)
        .idle_timeout(None)
        .max_lifetime(None)
}

/// Resolves a `sqlite:<file>` connection string to a full path under `app_data_dir`, matching
/// the directory `resolve_storage_paths` (main.rs) already reports, so the live
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

/// Connects the single-connection pool once. Later calls are no-ops.
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

    let pool = build_pool_options()
        .connect_with(connect_options)
        .await
        .map_err(|error| format!("Connexion SQLite impossible: {error}"))?;

    *guard = Some(pool);
    Ok(())
}

/// Pool-level `db_execute` so the command and the tests share one query/bind path.
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

/// Pool-level `db_select`, shared with the tests like `execute_on_pool`.
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

/// Executes a non-SELECT statement. Returns `(rows_affected, last_insert_rowid)`.
#[tauri::command]
pub async fn db_execute(state: State<'_, DbState>, query: String, values: Vec<JsonValue>) -> Result<(u64, i64), String> {
    let guard = state.0.lock().await;
    let pool = guard
        .as_ref()
        .ok_or_else(|| "Base de donnees SQLite non initialisee".to_string())?;

    execute_on_pool(pool, &query, values).await
}

/// Executes a SELECT. Returns one JSON object per row, keyed by column name.
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

    /// Same pool options as `db_connect`, on a tempfile rather than `:memory:` (in-memory DBs
    /// are private per connection and would hide a split-connection failure).
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

    /// Round-trips NULL/TEXT/INTEGER/REAL through `bind_value` + `column_to_json`.
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

    /// `rows_affected` / `last_insert_rowid` after an INSERT.
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

    /// BEGIN / INSERT / COMMIT as three separate pool calls must persist the row.
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

    /// Same as `test_pool` but with a short idle timeout so the reaper can close the connection
    /// between statements of an open transaction.
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

    /// Negative control: with the reaper enabled, COMMIT fails after an idle gap.
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

    /// Same sequence as the negative control, but `build_pool_options()` keeps the transaction.
    #[tokio::test(flavor = "multi_thread")]
    async fn build_pool_options_protects_an_open_transaction_from_the_reaper() {
        let (pool, _dir) = test_pool().await;

        execute_on_pool(&pool, "CREATE TABLE txn_protected (id INTEGER PRIMARY KEY, name TEXT)", vec![])
            .await
            .expect("create table");

        execute_on_pool(&pool, "BEGIN IMMEDIATE", vec![]).await.expect("begin immediate");

        // Same idle gap as the negative control; the reaper is disabled so this is inert.
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
