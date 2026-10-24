// DB12：每批仅保留首片事件行；范围索引把任意逻辑游标定位到完整原始正文块。
// DB10表/指纹保持原样，不重写旧成员行。控制事件仍由events唯一键约束。
export const EVENT_RANGES_SCHEMA_SQL = `
CREATE TABLE event_ranges(
 block_id TEXT PRIMARY KEY REFERENCES event_blocks(id),
 anchor_id TEXT NOT NULL UNIQUE REFERENCES events(event_id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL REFERENCES conversations(id),log_epoch TEXT NOT NULL,
 first_sequence INTEGER NOT NULL,last_sequence INTEGER NOT NULL,
 CHECK(first_sequence>0 AND last_sequence>first_sequence),
 UNIQUE(conversation_id,log_epoch,first_sequence));
CREATE TRIGGER immutable_event_range BEFORE UPDATE ON event_ranges
 BEGIN SELECT RAISE(ABORT,'历史事件范围不可修改'); END;
CREATE TRIGGER event_range_insert BEFORE INSERT ON event_ranges BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM event_blocks b JOIN events e ON e.event_id=NEW.anchor_id
  WHERE b.id=NEW.block_id AND b.conversation_id=NEW.conversation_id AND b.log_epoch=NEW.log_epoch
   AND b.first_sequence=NEW.first_sequence AND b.last_sequence=NEW.last_sequence
   AND e.conversation_id=NEW.conversation_id AND e.log_epoch=NEW.log_epoch AND e.sequence=NEW.first_sequence
   AND json_extract(e.payload,'$.$umiStream')=NEW.block_id
 ) OR EXISTS(SELECT 1 FROM events WHERE conversation_id=NEW.conversation_id AND log_epoch=NEW.log_epoch
  AND sequence>NEW.first_sequence AND sequence<=NEW.last_sequence)
 OR NEW.first_sequence<=COALESCE((SELECT last_sequence FROM event_ranges
  WHERE conversation_id=NEW.conversation_id AND log_epoch=NEW.log_epoch AND first_sequence<=NEW.last_sequence
  ORDER BY first_sequence DESC LIMIT 1),0)
 THEN RAISE(ABORT,'事件范围冲突或绑定无效') END;
END;
CREATE TRIGGER event_scalar_range_insert BEFORE INSERT ON events WHEN NEW.sequence<=COALESCE((
 SELECT last_sequence FROM event_ranges WHERE conversation_id=NEW.conversation_id AND log_epoch=NEW.log_epoch
 AND first_sequence<=NEW.sequence ORDER BY first_sequence DESC LIMIT 1),0)
 BEGIN SELECT RAISE(ABORT,'事件序号已被流批次占用'); END;
`;
