// 迁移11：只增加已确认热路径的非唯一索引，不改写历史正文或资料身份。
export const HOT_PATH_INDEXES_SQL = `
CREATE INDEX hot_artifacts_kind_hash ON artifacts(kind,hash);
CREATE INDEX hot_command_grants_run ON artifacts(json_extract(content,'$.runId')) WHERE kind='command-task-grant';
CREATE INDEX hot_command_grants_approval ON artifacts(json_extract(content,'$.approvalId')) WHERE kind='command-task-grant';
CREATE INDEX hot_command_reuse_execution ON artifacts(json_extract(content,'$.executionId')) WHERE kind='command-task-reuse';
CREATE INDEX hot_messages_user_run ON messages(run_id) WHERE role='user';
CREATE INDEX hot_messages_turn_role_applied ON messages(turn_id,role,applied);
`;
