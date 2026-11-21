-- Bus de eventos: cada INSERT en "event" emite NOTIFY con un payload mínimo.
-- Los oyentes leen la fila completa por seq (el payload de NOTIFY está limitado a 8000 bytes).
CREATE OR REPLACE FUNCTION ega_notify_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'ega_events',
    json_build_object('seq', NEW.seq::text, 'workspaceId', NEW."workspaceId", 'subject', NEW.subject, 'type', NEW.type)::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_notify AFTER INSERT ON "event"
FOR EACH ROW EXECUTE FUNCTION ega_notify_event();
