import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type ReviewState = "pending" | "approved" | "rejected";
export interface EvidenceRecord {
  id: string;
  billId: string;
  mediaType: "image/jpeg" | "image/png" | "application/pdf";
  sha256: string;
  size: number;
  state: ReviewState;
  createdAt: string;
  reviewedAt?: string;
  reviewerId?: string;
  /** The only fields that may leave the review boundary. */
  redacted?: { provider: string; amountMinor: number; currency: string; dueDate?: string; referenceLast4?: string };
}

export class EvidenceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "application/pdf"]);

function assertMedia(bytes: Buffer, declared: string): asserts declared is EvidenceRecord["mediaType"] {
  if (!ALLOWED.has(declared)) throw new EvidenceError(415, "Only JPEG, PNG, or PDF evidence is accepted.");
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const pdf = bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (!(declared === "image/jpeg" && jpeg || declared === "image/png" && png || declared === "application/pdf" && pdf)) {
    throw new EvidenceError(415, "The file signature does not match its declared media type.");
  }
}

/** Internal-only encrypted quarantine and explicit human redaction gate. */
export class EvidenceVault {
  private readonly root: string;
  private readonly key: Buffer;
  private readonly now: () => number;
  constructor(root: string, key: Buffer, now: () => number = Date.now) {
    this.root = root; this.key = key; this.now = now;
    if (key.length !== 32) throw new Error("Evidence encryption key must be 32 bytes.");
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  private path(id: string, suffix: "blob" | "json") {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new EvidenceError(404, "Evidence not found.");
    return join(this.root, `${id}.${suffix}`);
  }

  private save(record: EvidenceRecord) { writeFileSync(this.path(record.id, "json"), JSON.stringify(record), { mode: 0o600 }); }

  private audit(id: string, action: string, actor: string) {
    const entry = JSON.stringify({ at: new Date(this.now()).toISOString(), evidenceId: id, action, actor }) + "\n";
    // Audit log excludes document content. Keep the directory private and back it up separately.
    appendFileSync(join(this.root, "audit.jsonl"), entry, { mode: 0o600 });
  }

  upload(billId: string, mediaType: string, bytes: Buffer, actor: string): EvidenceRecord {
    if (!/^[A-Za-z0-9_-]{3,100}$/.test(billId)) throw new EvidenceError(400, "Invalid bill ID.");
    if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new EvidenceError(413, "Evidence must be between 1 byte and 5 MB.");
    assertMedia(bytes, mediaType);
    const id = randomUUID();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    writeFileSync(this.path(id, "blob"), Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600, flag: "wx" });
    const record: EvidenceRecord = { id, billId, mediaType, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, state: "pending", createdAt: new Date(this.now()).toISOString() };
    this.save(record);
    this.audit(id, "uploaded", actor);
    return record;
  }

  get(id: string): EvidenceRecord {
    const path = this.path(id, "json");
    if (!existsSync(path)) throw new EvidenceError(404, "Evidence not found.");
    return JSON.parse(readFileSync(path, "utf8")) as EvidenceRecord;
  }

  /** Raw bytes are available only through the private reviewer role. */
  openForReview(id: string, reviewerId: string): Buffer {
    const record = this.get(id);
    const payload = readFileSync(this.path(id, "blob"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    const bytes = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
    if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) throw new Error("Evidence integrity check failed.");
    this.audit(id, "opened_for_review", reviewerId);
    return bytes;
  }

  review(id: string, reviewerId: string, decision: "approved" | "rejected", redacted?: EvidenceRecord["redacted"]): EvidenceRecord {
    const record = this.get(id);
    if (record.state !== "pending") throw new EvidenceError(409, "Evidence has already been reviewed.");
    if (decision === "approved") {
      if (!redacted || !/^[\p{L} .'-]{2,100}$/u.test(redacted.provider) || !Number.isSafeInteger(redacted.amountMinor) || redacted.amountMinor <= 0 || !/^[A-Z]{3}$/.test(redacted.currency)) {
        throw new EvidenceError(400, "Approved evidence needs a minimal redacted provider, amount, and currency.");
      }
      const fields = Object.keys(redacted);
      if (fields.some((field) => !["provider", "amountMinor", "currency", "dueDate", "referenceLast4"].includes(field))) throw new EvidenceError(400, "Unexpected field in the redacted summary.");
      if (redacted.referenceLast4 && !/^[A-Za-z0-9]{4}$/.test(redacted.referenceLast4)) throw new EvidenceError(400, "Only the final four reference characters may be kept.");
      if (redacted.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(redacted.dueDate)) throw new EvidenceError(400, "Due date must be YYYY-MM-DD.");
    }
    record.state = decision;
    record.reviewedAt = new Date(this.now()).toISOString();
    record.reviewerId = reviewerId;
    if (decision === "approved" && redacted) {
      record.redacted = {
        provider: redacted.provider,
        amountMinor: redacted.amountMinor,
        currency: redacted.currency,
        ...(redacted.dueDate ? { dueDate: redacted.dueDate } : {}),
        ...(redacted.referenceLast4 ? { referenceLast4: redacted.referenceLast4 } : {}),
      };
    }
    this.save(record);
    this.audit(id, decision, reviewerId);
    return record;
  }

  publicSummary(id: string) {
    const record = this.get(id);
    return { id: record.id, billId: record.billId, state: record.state, ...(record.state === "approved" ? { verified: record.redacted } : {}) };
  }

  purgeOriginalsOlderThan(days: number): number {
    if (!Number.isInteger(days) || days < 1) throw new Error("Retention days must be positive.");
    let count = 0;
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith(".json")) continue;
      const record = this.get(name.slice(0, -5));
      if (record.state === "pending" || this.now() - Date.parse(record.reviewedAt ?? record.createdAt) < days * 86_400_000) continue;
      const path = this.path(record.id, "blob");
      if (existsSync(path)) { unlinkSync(path); count++; this.audit(record.id, "original_purged", "retention_job"); }
    }
    return count;
  }
}

export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
