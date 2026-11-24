ALTER TABLE control_commands
  ADD CONSTRAINT control_commands_pause_after_send_check
  CHECK (paused_at IS NULL OR sent_at IS NULL OR paused_at >= sent_at);

ALTER TABLE control_commands
  ADD CONSTRAINT control_commands_first_pause_after_ack_check
  CHECK (paused_at IS NULL OR resumed_at IS NOT NULL OR acked_at IS NULL OR paused_at >= acked_at);

ALTER TABLE control_commands
  ADD CONSTRAINT control_commands_resume_after_pause_check
  CHECK (resumed_at IS NULL OR paused_at IS NULL OR resumed_at >= paused_at);
