-- Keep request identities after detail retention, so retrying an import cannot
-- recreate pruned requests or duplicate their immutable project events.
CREATE TABLE gateway_request_receipts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES gateway_connections(id),
  event_hash TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  UNIQUE (connection_id, event_hash)
);

INSERT INTO gateway_request_receipts(connection_id, event_hash, ingested_at)
SELECT connection_id, event_hash, ingested_at FROM gateway_requests ORDER BY rowid;

CREATE TRIGGER gateway_requests_deduplicate_receipt
BEFORE INSERT ON gateway_requests
WHEN EXISTS (
  SELECT 1 FROM gateway_request_receipts
  WHERE connection_id = NEW.connection_id AND event_hash = NEW.event_hash
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER gateway_requests_record_receipt
AFTER INSERT ON gateway_requests
BEGIN
  INSERT INTO gateway_request_receipts(connection_id, event_hash, ingested_at)
  VALUES (NEW.connection_id, NEW.event_hash, NEW.ingested_at);
END;

CREATE INDEX gateway_requests_team_time ON gateway_requests(occurred_at, connection_id);
