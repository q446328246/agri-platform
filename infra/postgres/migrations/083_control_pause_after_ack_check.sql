ALTER TABLE control_commands
  DROP CONSTRAINT IF EXISTS control_commands_first_pause_after_ack_check;

ALTER TABLE control_commands
  ADD CONSTRAINT control_commands_pause_after_ack_check
  CHECK (paused_at IS NULL OR status <> 'PAUSED' OR acked_at IS NULL OR paused_at >= acked_at);
