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
    # 值A if 条件 else 值B
    # .expanduser() 是 Python 中用于将路径中的 ~ 符号展开为用户主目录的方法
    db_dir = Path(configured_dir).expanduser() if configured_dir else Path(
        # user_data_dir("Umi", "Umi") 返回系统标准数据目录字符串
        user_data_dir("Umi", "Umi")
    )
    # mkdir()：建目录
    # parents=True：父目录不存在也一起建
    # exist_ok=True：如果目录已存在，不抛异常
    db_dir.mkdir(parents=True, exist_ok=True)
    # db_dir / DB_FILENAME：Path 重载了 / 运算符，用来拼路径
    # 结果类似 /Users/me/Library/Application Support/Umi/umi.db
    # .resolve()：转成绝对路径，并解析掉 ..、.、软链接
    return (db_dir / DB_FILENAME).resolve()

# connection: aiosqlite.Connection：参数，类型是 aiosqlite 连接
async def init_db(connection: aiosqlite.Connection) -> None:
    """Create Umi's business tables in a new or existing SQLite database."""
    # executescript 是 aiosqlite 的方法，一次执行多条 SQL 语句
    # execute：一条语句，可带参数
    # executescript：多条语句，不能带参数
    await connection.executescript(
        # 初始化 Umi 应用的数据库结构，创建"工作区、对话线程、消息版本、消息归档"四张业务表及相关索引，
        # 并插入一条默认的 Chat 工作区记录。
        # 因为是 CREATE TABLE IF NOT EXISTS 和 INSERT OR IGNORE，所以可重复执行，已有结构/数据不会报错或重复。
        """
        CREATE TABLE IF NOT EXISTS umi_workspaces (
            workspace_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT,
            mode TEXT NOT NULL CHECK (mode IN ('chat', 'work')),
            worktree_root TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT OR IGNORE INTO umi_workspaces
            (workspace_id, name, path, mode)
        VALUES ('default_chat', 'Chat', NULL, 'chat');

        CREATE TABLE IF NOT EXISTS umi_threads (
            thread_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '新对话',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
            active_leaf_thread_id TEXT,
            worktree_path TEXT,
            CONSTRAINT fk_umi_threads_workspace
                FOREIGN KEY (workspace_id)
                REFERENCES umi_workspaces (workspace_id)
                ON DELETE CASCADE
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
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            CONSTRAINT fk_umi_message_archive_thread
                FOREIGN KEY (thread_id)
                REFERENCES umi_threads (thread_id)
                ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_umi_message_archive_thread
            ON umi_message_archive (thread_id, leaf_thread_id);

        CREATE INDEX IF NOT EXISTS idx_umi_threads_workspace
            ON umi_threads (workspace_id, pinned, updated_at);
        """
    )
    # executescript 执行完后，显式提交。SQLite 里 DDL 通常会自动提交，但显式 commit 更保险。
    await connection.commit()


async def get_sqlite_checkpointer():
    """Open the shared SQLite connection and initialize all required tables."""
    global _checkpointer_context # _checkpointer_context 是全局变量，用于存储 AsyncSqliteSaver 实例
                                 # 也称上下文管理器

    # 这是单例模式的初始化保护，意思是：全局只允许初始化一次 SQLite 存储，重复初始化直接报错
    if _checkpointer_context is not None:
        raise RuntimeError("SQLite store is already initialized")

    db_path = get_database_path()
    # 把 Path 转成字符串，因为 from_conn_string 要字符串
    # AsyncSqliteSaver.from_conn_string(...)：类方法，返回一个异步上下文管理器（不是连接本身）
    _checkpointer_context = AsyncSqliteSaver.from_conn_string(str(db_path))
    try:
        # __aenter__ 是异步"上下文管理器"的进入方法（对应 async with 的内部调用）
        # 手动调用它 = 手动执行 async with 的进入部分
        # 此时才真正建立 SQLite 连接
        checkpointer = await _checkpointer_context.__aenter__()
        # checkpointer.conn：AsyncSqliteSaver 内部的 aiosqlite.Connection
        # 把 AsyncSqliteSaver 内部包着的那个真正的 aiosqlite 连接拿出来"，
        # 因为建业务表、设 row_factory、执行 PRAGMA 这些底层操作，高层封装对象不提供，只能找它要底层连接。
        connection = checkpointer.conn
        # row_factory = aiosqlite.Row：设置查询结果的行类型
        # 默认：row[0]、row[1] 按索引取
        # 设置后：row["thread_id"] 按列名取，更可读
        connection.row_factory = aiosqlite.Row

        await connection.execute("PRAGMA foreign_keys = ON") # 开启外键约束（SQLite 默认关闭）。开了之后，插入的 thread_id 必须存在于 umi_threads
        await connection.execute("PRAGMA busy_timeout = 5000") # 数据库被锁时，最多等 5000 毫秒再报错
        await connection.execute("PRAGMA journal_mode = WAL") # 用 Write-Ahead Logging 模式，读和写不互相阻塞
        await connection.execute("PRAGMA synchronous = NORMAL")# 降低 fsync 频率，性能更好，崩溃时可能丢最后一点数据

        await checkpointer.setup() # LangGraph 自己建它需要的 checkpoint 表
        await init_db(connection) # 调用上面写的函数，建业务表
    except Exception:
        # 清理，防止半初始化状态残留
        await close_sqlite_store()
        # 重新抛出异常。这里没有 raise 就会吞掉异常，调用方以为成功了。所以必须 raise
        raise

    print(f"Umi SQLite 数据库: {db_path}")
    return checkpointer, connection


async def close_sqlite_store() -> None:
    """Close the connection owned by AsyncSqliteSaver.from_conn_string()."""
    global _checkpointer_context
    if _checkpointer_context is not None:
        context = _checkpointer_context # 先把全局值拷贝到局部变量
        _checkpointer_context = None # 立即清空全局，防止重入
        # 用局部变量关闭
        # 异步上下文管理器的退出方法，三个参数对应：async def __aexit__(self, exc_type, exc_val, exc_tb):
        # exc_type：异常类型
        # exc_val：异常值
        # exc_tb：异常栈跟踪
        await context.__aexit__(None, None, None)
