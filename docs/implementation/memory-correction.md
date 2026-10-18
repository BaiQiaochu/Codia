# Memory provenance and correction

The existing agent-local fact database now preserves source references on insertion, import and search, and migrates timestamps/status without discarding records. The existing memory settings viewer exposes source-session navigation only when a valid same-agent session is known. Unsupported or imported document references remain visible identifiers rather than fabricated links.

Individual correction uses optimistic updated_at matching; stale edits return a conflict rather than overwriting a newer correction. Active, expired and conflict states are explicit. Expired entries are excluded from fact retrieval. Deleting a fact removes its FTS/search result. Existing agent/channel boundaries remain in force.

These actions change the fact store, not all historical chat text or separately compiled summaries. The UI discloses that distinction and the existing compiled-memory controls remain available. No project document-space isolation is claimed; that product remains deferred.

Validation covers migration, provenance import/export, stale-write conflicts, deletion retrieval, expiry, same-agent source links and channel/agent isolation.
