// 迁移8：只新增事实，不改写旧副本、批准或迁移指纹。
export const DIRECT_FILES_SCHEMA_SQL = `
CREATE TABLE workspace_file_grants(
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),root TEXT NOT NULL,root_identity TEXT NOT NULL,
 scope TEXT NOT NULL,access TEXT NOT NULL CHECK(access IN('read','edit')),authority TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN(0,1)),created_at TEXT NOT NULL);
CREATE TABLE direct_file_environments(environment_id TEXT PRIMARY KEY REFERENCES environments(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id));
CREATE TABLE direct_file_mounts(id TEXT PRIMARY KEY,environment_id TEXT NOT NULL REFERENCES environments(id),resource_id TEXT NOT NULL REFERENCES resource_candidates(id),
 grant_id TEXT NOT NULL REFERENCES workspace_file_grants(id),baseline_ref TEXT NOT NULL REFERENCES artifacts(id),UNIQUE(environment_id,grant_id));
CREATE TABLE file_changes(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),environment_id TEXT NOT NULL REFERENCES environments(id),
 mount_id TEXT NOT NULL REFERENCES direct_file_mounts(id),execution_id TEXT UNIQUE REFERENCES tool_executions(id),path TEXT NOT NULL,
 before_ref TEXT REFERENCES artifacts(id),after_ref TEXT REFERENCES artifacts(id),before_entry TEXT NOT NULL,after_entry TEXT,
 desired_hash TEXT,state TEXT NOT NULL CHECK(state IN('intent','settled','not_applied')),restores_id TEXT REFERENCES file_changes(id),created_at TEXT NOT NULL);
CREATE TRIGGER immutable_direct_mount BEFORE UPDATE ON direct_file_mounts BEGIN SELECT RAISE(ABORT,'直改绑定不可改写'); END;
CREATE TRIGGER immutable_file_grant BEFORE UPDATE OF id,workspace_id,root,root_identity,scope,access,authority ON workspace_file_grants BEGIN SELECT RAISE(ABORT,'目录授权对象不可改写'); END;
CREATE INDEX direct_grants_workspace ON workspace_file_grants(workspace_id,revoked);
CREATE INDEX file_changes_conversation ON file_changes(conversation_id,created_at);
`;
