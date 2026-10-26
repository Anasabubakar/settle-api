# Private evidence service

`npm run evidence` starts a second localhost-only process on port 8790. It requires `SETTLE_EVIDENCE_KEY_HEX` (32-byte key in hex), `SETTLE_EVIDENCE_UPLOAD_TOKEN`, and `SETTLE_EVIDENCE_REVIEWER_TOKEN` (independent 32+ character values). The service is for internal synthetic-data rehearsal, not public deployment.

| Method | Path | Role | Result |
|---|---|---|---|
| POST | `/internal/evidence` | upload | Encrypted original, pending review ID |
| GET | `/internal/evidence/{id}/raw` | reviewer | Original bytes; access audited |
| POST | `/internal/evidence/{id}/review` | reviewer | Approve/reject and restricted redacted fields |
| GET | `/internal/evidence/{id}/summary` | either | Status and approved redacted fields only |

The upload body is JSON with `billId`, `mediaType`, and `base64`. Files are capped at 5 MB and checked by file signature. Originals use AES-256-GCM at rest, metadata files and the audit log are private. The `EvidenceVault.purgeOriginalsOlderThan(days)` method removes reviewed originals; deployment must schedule it and apply the jurisdiction-approved period.

The current workflow relies on a human to create the redacted field summary. Automated extraction, EXIF stripping, malware scanning, reviewer identity/authorization, and a secure document viewing UI remain future work. Do not submit real personal documents until those controls exist.
