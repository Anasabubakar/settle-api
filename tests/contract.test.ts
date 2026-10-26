import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createApp } from "../src/http.ts";
import { createHarness } from "./helpers.ts";

/** "METHOD /path" pairs declared in openapi.yaml, read without a YAML dependency. */
function documented(): string[] {
  const found: string[] = [];
  let path: string | undefined;
  for (const line of readFileSync("openapi.yaml", "utf8").split("\n")) {
    const pathMatch = /^ {2}(\/\S*):$/.exec(line);
    if (pathMatch) path = pathMatch[1];
    else if (/^\S/.test(line)) path = undefined;
    const method = /^ {4}(get|post|put|patch|delete):$/.exec(line);
    if (method && path) found.push(`${method[1]!.toUpperCase()} ${path}`);
  }
  return found.sort();
}

describe("the OpenAPI contract and the router agree", () => {
  const h = createHarness();
  const app = createApp({ config: h.config, service: h.service });

  it("document exactly the endpoints the server serves", () => {
    assert.deepEqual([...app.routes].sort(), documented());
  });

  it("every endpoint has a stable operationId", () => {
    const ids = [...readFileSync("openapi.yaml", "utf8").matchAll(/operationId: (\w+)/g)].map((match) => match[1]);
    assert.equal(ids.length, app.routes.length);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("states that client authority is forbidden, as the server enforces", () => {
    const text = readFileSync("openapi.yaml", "utf8");
    for (const field of ["destination", "assetIssuer", "providerId", "usdcAmountStroops", "memo", "rate"]) {
      assert.match(text, new RegExp(`\`${field}\``), `${field} should be named as never accepted from a client`);
    }
    assert.match(text, /client_authority_forbidden/);
  });
});
