// 迁移10：原事件行保留唯一身份、幂等键和序号；仅新批次正文引用无损压缩块。
// 旧payload原样读取，不重写旧历史。控制/授权/副作用事件继续独立保存。
export const EVENT_BLOCKS_SCHEMA_SQL = `
CREATE TABLE event_blocks(
 id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),log_epoch TEXT NOT NULL,
 first_sequence INTEGER NOT NULL CHECK(first_sequence>0),last_sequence INTEGER NOT NULL,
 member_count INTEGER NOT NULL CHECK(member_count BETWEEN 2 AND 64),
 decoded_bytes INTEGER NOT NULL CHECK(decoded_bytes BETWEEN 1 AND 2097152),
 codec TEXT NOT NULL CHECK(codec='json-deflate-v1'),hash TEXT NOT NULL,last_at TEXT NOT NULL,content BLOB NOT NULL,
 CHECK(last_sequence-first_sequence+1=member_count),UNIQUE(conversation_id,log_epoch,first_sequence));
CREATE TRIGGER immutable_event_block BEFORE UPDATE ON event_blocks BEGIN SELECT RAISE(ABORT,'历史事件块不可修改'); END;
`;
