import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { EvidenceError, EvidenceVault, tokenMatches } from "./evidence.ts";

const env = process.env;
const uploadToken = env.SETTLE_EVIDENCE_UPLOAD_TOKEN ?? "";
const reviewerToken = env.SETTLE_EVIDENCE_REVIEWER_TOKEN ?? "";
const encryptionKey = env.SETTLE_EVIDENCE_KEY_HEX ?? "";
if (uploadToken.length < 32 || reviewerToken.length < 32 || !/^[a-fA-F0-9]{64}$/.test(encryptionKey)) {
  throw new Error("Evidence server requires two 32+ character role tokens and a 32-byte hex encryption key.");
}
const vault = new EvidenceVault(join(env.SETTLE_DATA_DIR ?? "./data", "evidence"), Buffer.from(encryptionKey, "hex"));
const MAX_REQUEST = 7 * 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const buffer = part as Buffer;
    size += buffer.length;
    if (size > MAX_REQUEST) throw new EvidenceError(413, "Request too large.");
    parts.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new EvidenceError(400, "Expected a JSON object."); }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const reviewer = tokenMatches(req.headers.authorization?.replace(/^Bearer /, ""), reviewerToken);
    const uploader = tokenMatches(req.headers.authorization?.replace(/^Bearer /, ""), uploadToken);
    if (!reviewer && !uploader) throw new EvidenceError(401, "Unauthorized.");
    if (req.method === "POST" && url.pathname === "/internal/evidence") {
      if (!uploader) throw new EvidenceError(403, "Upload role required.");
      const input = await body(req);
      if (typeof input.billId !== "string" || typeof input.mediaType !== "string" || typeof input.base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)) throw new EvidenceError(400, "Invalid evidence payload.");
      const record = vault.upload(input.billId, input.mediaType, Buffer.from(input.base64, "base64"), "requester_upload");
      json(res, 201, { id: record.id, billId: record.billId, state: record.state });
      return;
    }
    const match = /^\/internal\/evidence\/([0-9a-f-]{36})(?:\/(raw|review|summary))?$/.exec(url.pathname);
    if (!match) throw new EvidenceError(404, "Not found.");
    const [, id, action] = match;
    if (req.method === "GET" && action === "summary") {
      json(res, 200, vault.publicSummary(id!)); return;
    }
    if (!reviewer) throw new EvidenceError(403, "Reviewer role required.");
    if (req.method === "GET" && action === "raw") {
      const record = vault.get(id!);
      const bytes = vault.openForReview(id!, "named_reviewer");
      res.writeHead(200, { "content-type": record.mediaType, "content-disposition": "inline", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(bytes); return;
    }
    if (req.method === "POST" && action === "review") {
      const input = await body(req);
      if (input.decision !== "approved" && input.decision !== "rejected") throw new EvidenceError(400, "Invalid review decision.");
      if (typeof input.reviewerId !== "string" || !/^[A-Za-z0-9_-]{3,100}$/.test(input.reviewerId)) throw new EvidenceError(400, "Named reviewer ID required.");
      const record = vault.review(id!, input.reviewerId, input.decision, input.redacted as never);
      json(res, 200, { id: record.id, state: record.state, redacted: record.redacted }); return;
    }
    throw new EvidenceError(405, "Method not allowed.");
  } catch (error) {
    const status = error instanceof EvidenceError ? error.status : 500;
    json(res, status, { error: status === 500 ? "Internal error." : (error as Error).message });
  }
});

// A separate internal service: it must not share the public settlement port.
server.listen(Number(env.SETTLE_EVIDENCE_PORT ?? 8790), "127.0.0.1");
