ALTER TABLE system_messages
  ADD COLUMN popup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (popup_enabled IN (0, 1));

UPDATE system_messages
SET popup_enabled = 1
WHERE message_type = 'resubmission';
