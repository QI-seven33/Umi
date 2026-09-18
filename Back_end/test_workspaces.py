import pytest
from langchain_core.messages import HumanMessage

from umi import service


@pytest.mark.asyncio
async def test_workspace_thread_boundaries_and_delete(tmp_path, monkeypatch):
    monkeypatch.setenv("UMI_DB_PATH", str(tmp_path / "database"))
    project_one = tmp_path / "project-one"
    project_two = tmp_path / "project-two"
    project_one.mkdir()
    project_two.mkdir()

    await service.init_agent_service()
    try:
        workspace_one = await service.create_workspace(
            "Project One", str(project_one), "work"
        )
        workspace_two = await service.create_workspace(
            "Project Two", str(project_two), "work"
        )

        connection = service.db_connection
        for index in range(3):
            await connection.execute(
                """
                INSERT INTO umi_threads (thread_id, workspace_id, title)
                VALUES (?, 'default_chat', ?)
                """,
                (f"chat-{index}", f"Chat {index}"),
            )
        for workspace_id, prefix in (
            (workspace_one, "one"),
            (workspace_two, "two"),
        ):
            for index in range(2):
                await connection.execute(
                    """
                    INSERT INTO umi_threads (thread_id, workspace_id, title)
                    VALUES (?, ?, ?)
                    """,
                    (f"{prefix}-{index}", workspace_id, f"{prefix} {index}"),
                )
        await connection.commit()

        assert len(await service.list_conversations("default_chat")) == 3
        assert len(await service.list_conversations(workspace_one)) == 2
        assert len(await service.list_conversations(workspace_two)) == 2
        assert len(await service.search_conversations(workspace_one, "one")) == 2
        assert await service.search_conversations(workspace_one, "two") == []

        await service.graph.aupdate_state(
            {"configurable": {"thread_id": "one-0"}},
            {"messages": [HumanMessage(content="checkpoint")]},
            as_node="agent_node",
        )

        await service.delete_workspace(workspace_one)

        assert project_one.is_dir()
        assert await service.list_workspaces("work") == [
            await service.get_workspace(workspace_two)
        ]
        remaining = await connection.execute_fetchall(
            "SELECT thread_id FROM umi_threads WHERE workspace_id = ?",
            (workspace_one,),
        )
        assert remaining == []
        state = await service.graph.aget_state(
            {"configurable": {"thread_id": "one-0"}}
        )
        assert not state.values
    finally:
        await service.shutdown_agent_service()
