// 迁移9：仅保存最小完成凭据，不保存路径、正文或授权。与整组删除同事务提交。
export const WORKSPACE_DELETION_SQL = `
CREATE TABLE workspace_deletion_receipts(workspace_id TEXT PRIMARY KEY,conversation_ids TEXT NOT NULL,environment_ids TEXT NOT NULL,completed_at TEXT NOT NULL);
`;
