"""Persistent, per-destination retries for the single Google worker."""
import time


MAX_ATTEMPTS = 5
SCHEMA = """
CREATE TABLE IF NOT EXISTS google_delivery_retries (
    binding TEXT NOT NULL, target TEXT NOT NULL, job_id TEXT NOT NULL,
    attempts INTEGER NOT NULL, last_error TEXT NOT NULL, next_retry_at REAL NOT NULL,
    failed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(binding,target,job_id)
);
CREATE TABLE IF NOT EXISTS google_service_state (
    binding TEXT NOT NULL, target TEXT NOT NULL, last_success TEXT,
    last_error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at REAL NOT NULL DEFAULT 0, PRIMARY KEY(binding,target)
);
CREATE TABLE IF NOT EXISTS google_auth_state (
    binding TEXT PRIMARY KEY, credential_hash TEXT NOT NULL, state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS google_sheet_state (
    binding TEXT PRIMARY KEY, sheet_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS google_backfill_receipts (
    binding TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, digest TEXT NOT NULL,
    PRIMARY KEY(binding,kind,item_id,digest)
);
"""


def eligible(alias, target, key):
    # All expressions are internal constants, never user-provided SQL.
    return f"""NOT EXISTS (SELECT 1 FROM google_delivery_retries r
        WHERE r.binding={alias}.binding AND r.target='{target}' AND r.job_id=CAST({key} AS TEXT)
        AND (r.failed=1 OR r.next_retry_at>{time.time()}))"""


def failure(db, binding, target, job_id, detail):
    key = binding, target, str(job_id)
    row = db.execute("SELECT attempts FROM google_delivery_retries WHERE binding=? AND target=? AND job_id=?",
                     key).fetchone()
    attempts = (row[0] if row else 0) + 1
    db.execute("INSERT OR REPLACE INTO google_delivery_retries VALUES (?,?,?,?,?,?,?)",
               (*key, attempts, detail, time.time() + min(3600, 30 * 2 ** min(attempts - 1, 7)),
                attempts >= MAX_ATTEMPTS))


def success(db, binding, target, job_id, captured):
    db.execute("DELETE FROM google_delivery_retries WHERE binding=? AND target=? AND job_id=?",
               (binding, target, str(job_id)))
    db.execute("""INSERT INTO google_service_state(binding,target,last_success) VALUES (?,?,?)
        ON CONFLICT(binding,target) DO UPDATE SET last_success=excluded.last_success""",
               (binding, target, captured))
