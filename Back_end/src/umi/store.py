import os
from pathlib import Path

import aiosqlite
from dotenv import load_dotenv
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from platformdirs import user_data_dir

load_dotenv()

DB_FILENAME = "umi.db"

_checkpointer_context = None


def get_database_path() -> Path:
    """Return the SQLite file path, creating its parent directory if needed."""
    configured_dir = os.getenv("UMI_DB_PATH")
    db_dir = Path(configured_dir).expanduser() if configured_dir else Path(
        user_data_dir("Umi", "Umi")
    )
    db_dir.mkdir(parents=True, exist_ok=True)
    return (db_dir / DB_FILENAME).resolve()


async def init_db(connection: aiosqlite.Connection) -> None:
    """Create Umi's business tables in a new or existing SQLite database."""
    await connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS umi_threads (
            thread_id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '新对话',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
            active_leaf_thread_id TEXT
        );

        CREATE TABLE IF NOT EXISTS umi_message_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT NOT NULL,
            version_group_id TEXT NOT NULL,
            branch_num INTEGER NOT NULL,
            hidden_thread_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            CONSTRAINT uq_message_versions_branch
                UNIQUE (thread_id, version_group_id, branch_num),
            CONSTRAINT fk_umi_message_versions_thread
                FOREIGN KEY (thread_id)
                REFERENCES umi_threads (thread_id)
                ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS umi_message_archive (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT NOT NULL,
            leaf_thread_id TEXT NOT NULL,
            message_id TEXT,
            version_group_id TEXT,
            version_num INTEGER NOT NULL DEFAULT 0,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            additional_kwargs TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_umi_message_archive_thread
            ON umi_message_archive (thread_id, leaf_thread_id);
        """
    )
    await connection.commit()


async def get_sqlite_checkpointer():
    """Open the shared SQLite connection and initialize all required tables."""
    global _checkpointer_context

    if _checkpointer_context is not None:
        raise RuntimeError("SQLite store is already initialized")

    db_path = get_database_path()
    _checkpointer_context = AsyncSqliteSaver.from_conn_string(str(db_path))
    try:
        checkpointer = await _checkpointer_context.__aenter__()
        connection = checkpointer.conn
        connection.row_factory = aiosqlite.Row

        await connection.execute("PRAGMA foreign_keys = ON")
        await connection.execute("PRAGMA busy_timeout = 5000")
        await connection.execute("PRAGMA journal_mode = WAL")
        await connection.execute("PRAGMA synchronous = NORMAL")

        await checkpointer.setup()
        await init_db(connection)
    except Exception:
        await close_sqlite_store()
        raise

    print(f"Umi SQLite 数据库: {db_path}")
    return checkpointer, connection


async def close_sqlite_store() -> None:
    """Close the connection owned by AsyncSqliteSaver.from_conn_string()."""
    global _checkpointer_context
    if _checkpointer_context is not None:
        context = _checkpointer_context
        _checkpointer_context = None
        await context.__aexit__(None, None, None)
