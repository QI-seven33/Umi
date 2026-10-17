// 新增迁移 6；旧候选没有范围行，读取时解释为目录，不改写旧事实。
export const RESOURCE_SCOPE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS resource_scopes(resource_id TEXT PRIMARY KEY REFERENCES resource_candidates(id),scope TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS immutable_resource_scope BEFORE UPDATE ON resource_scopes
    BEGIN SELECT RAISE(ABORT,'资源范围不可修改'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_resource_scope_delete BEFORE DELETE ON resource_scopes
    BEGIN SELECT RAISE(ABORT,'资源范围不可删除'); END;
`;
