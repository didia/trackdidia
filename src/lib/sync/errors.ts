/**
 * Typed failures of the change-set model and of applying one. Callers match on `code`, never on the
 * message. Nothing here knows about storage.
 */

export type SyncChangeSetErrorCode =
  /** Not an object, a wrong type, a missing or unexpected key. */
  | "invalid_shape"
  | "unsupported_format_version"
  /** A clock that is not in the canonical HLC encoding. */
  | "invalid_clock"
  /** `hlcHigh` is below a clock the change set carries. */
  | "hlc_high_too_low"
  | "unknown_table"
  /** The table exists but is device-local, a by-entity-type sidecar, or in another domain. */
  | "table_not_in_domain"
  | "invalid_entity"
  | "invalid_entity_id"
  | "entity_id_too_long"
  | "duplicate_entity"
  | "invalid_row"
  /** An alias row that is malformed, of a table without aliased natural keys, or mis-ordered. */
  | "invalid_alias"
  | "too_many_aliases"
  /** A settings key that is unknown, device-scoped, secret or in another domain. */
  | "setting_not_syncable"
  | "invalid_setting_value";

/** A change set that is not well formed. Thrown before anything is read or written. */
export class SyncChangeSetError extends Error {
  readonly code: SyncChangeSetErrorCode;
  /** Where in the change set the problem is (for example `entities[3].fieldClocks`). */
  readonly path: string;

  constructor(code: SyncChangeSetErrorCode, path: string, message: string) {
    super(`${code}: ${path}: ${message}`);
    this.name = "SyncChangeSetError";
    this.code = code;
    this.path = path;
  }
}

export type SyncApplyErrorCode =
  /** The domain passed to the call differs from the one in the change set. */
  | "domain_mismatch"
  /** The device profile does not allow this domain (`assertDomainAllowed`). */
  | "domain_not_allowed"
  /** A table whose merge class this build cannot merge yet. The whole bundle is refused. */
  | "unsupported_merge_class"
  /** Change capture is not installed, so local edits could not be told apart from remote ones. */
  | "capture_disabled"
  /**
   * Change capture is installed but its backfill has not finished: some entities still have no
   * clocks or snapshots, so applying a peer's state (or publishing ours) would be unsafe.
   */
  | "backfill_incomplete"
  /** The sender has migrated further than this device. */
  | "schema_newer_than_local"
  /**
   * A unique key the registry declares as a natural key collided although the alias engine ran
   * first: the collision could not be resolved by canonical identity (for example a key that an
   * edit changes onto a row the bundle did not name).
   */
  | "natural_key_collision"
  /** A unique key the registry does not declare collided. */
  | "unique_violation"
  | "sql_error"
  /** Merging one entity failed (for example a corrupt local clock). */
  | "merge_failed"
  /** A settings key a bundle may never write (unknown, device-scoped, secret, other domain). */
  | "setting_not_syncable"
  | "invalid_setting_value"
  /**
   * A row the table's registry `rowFilter` says is never published (a running or paused Pomodoro
   * session, a segment of one). An honest peer cannot send it, so the whole bundle is refused.
   */
  | "row_filter_violation"
  /**
   * An incoming terminal Pomodoro session or segment would replace or delete part of a timer that is
   * running or paused on this laptop. Impossible between honest peers; the bundle is refused so the
   * live timer is never corrupted.
   */
  | "local_timer_conflict"
  /** A declared foreign key whose delete action the apply path has no convergent rule for. */
  | "unsupported_foreign_key";

/** A bundle that was refused or aborted. When it is thrown from a transaction, nothing was kept. */
export class SyncApplyError extends Error {
  readonly code: SyncApplyErrorCode;
  readonly table: string | null;
  readonly entityId: string | null;
  /** The unique index (or constraint columns) involved, when known. */
  readonly index: string | null;

  constructor(
    code: SyncApplyErrorCode,
    message: string,
    details: {
      table?: string | null;
      entityId?: string | null;
      index?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "SyncApplyError";
    this.code = code;
    this.table = details.table ?? null;
    this.entityId = details.entityId ?? null;
    this.index = details.index ?? null;
  }
}
