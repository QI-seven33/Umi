// 新迁移，保留1～6的SQL与指纹；清理项不保存会话内容。
export const CONVERSATION_DELETION_SQL = `
CREATE TABLE conversation_deletions(environment_id TEXT PRIMARY KEY,root TEXT NOT NULL,root_identity TEXT NOT NULL,
  deleted_at TEXT NOT NULL,last_error TEXT);
DROP TRIGGER IF EXISTS immutable_resource_scope_delete;
CREATE TRIGGER immutable_resource_scope_delete BEFORE DELETE ON resource_scopes
WHEN NOT EXISTS(SELECT 1 FROM resource_candidates c JOIN conversation_deletions d ON d.environment_id=c.environment_id
  WHERE c.id=OLD.resource_id)
BEGIN SELECT RAISE(ABORT,'资源范围只能随明确删除的会话清理'); END;
`;
