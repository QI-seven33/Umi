import sqlite3

import pytest

from umi.store import close_sqlite_store, get_sqlite_checkpointer


@pytest.mark.asyncio
async def test_sqlite_store_initializes_schema_and_pragmas(tmp_path, monkeypatch):
    monkeypatch.setenv("UMI_DB_PATH", str(tmp_path))

    _, connection = await get_sqlite_checkpointer()
    try:
        assert (tmp_path / "umi.db").is_file()

        cursor = await connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
        tables = {row["name"] for row in await cursor.fetchall()}
        assert {
            "checkpoints",
            "writes",
            "umi_threads",
            "umi_message_versions",
            "umi_message_archive",
        }.issubset(tables)

        foreign_keys = await (
            await connection.execute("PRAGMA foreign_keys")
        ).fetchone()
        journal_mode = await (
            await connection.execute("PRAGMA journal_mode")
        ).fetchone()
        busy_timeout = await (
            await connection.execute("PRAGMA busy_timeout")
        ).fetchone()

        assert foreign_keys[0] == 1
        assert journal_mode[0] == "wal"
        assert busy_timeout[0] == 5000

        with pytest.raises(sqlite3.IntegrityError):
            await connection.execute(
                """
                INSERT INTO umi_message_versions
                    (thread_id, version_group_id, branch_num,
                     hidden_thread_id, kind)
                VALUES (?, ?, ?, ?, ?)
                """,
                ("missing", "group", 0, "missing", "root"),
            )
        await connection.rollback()
    finally:
        await close_sqlite_store()
