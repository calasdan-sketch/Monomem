// Round 5: settings that move trust show up in securityFindings (so in health and doctor).
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { securityFindings } from "../src/health.js";

const KEYS = ["MONOMEM_EMBEDDINGS", "MONOMEM_EMBED_URL", "MONOMEM_ALLOWED_ORIGINS", "MONOMEM_NO_CHMOD", "MONOMEM_TRUST_PROXY", "MONOMEM_TRUST_CLOUDFLARE", "MONOMEM_RUNNER_ACCEPT_LEGACY", "MONOMEM_LINT"];
async function withEnv(env: Record<string, string>, bind: string): Promise<Array<{ id: string; status: string }>> {
  const saved = KEYS.map((k) => process.env[k]);
  KEYS.forEach((k) => delete process.env[k]);
  Object.assign(process.env, env);
  try {
    return await securityFindings(tmpdir(), bind);
  } finally {
    KEYS.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
}
const ids = (f: Array<{ id: string }>) => f.map((x) => x.id);

test("remote embeddings warn only when embeddings are on; local ones do not", async () => {
  assert.ok(ids(await withEnv({ MONOMEM_EMBEDDINGS: "1", MONOMEM_EMBED_URL: "https://api.example.com/v1/embeddings" }, "127.0.0.1")).includes("embed-remote"));
  assert.ok(!ids(await withEnv({ MONOMEM_EMBEDDINGS: "1", MONOMEM_EMBED_URL: "http://127.0.0.1:11434/v1/embeddings" }, "127.0.0.1")).includes("embed-remote"));
  assert.ok(!ids(await withEnv({ MONOMEM_EMBED_URL: "https://api.example.com/v1/embeddings" }, "127.0.0.1")).includes("embed-remote"));
});

test("custom origins, legacy runners and a MONOMEM_LINT typo warn", async () => {
  const f = await withEnv({ MONOMEM_ALLOWED_ORIGINS: "https://a.example", MONOMEM_RUNNER_ACCEPT_LEGACY: "1", MONOMEM_LINT: "blokc" }, "127.0.0.1");
  for (const id of ["origins", "runner-legacy", "lint-typo"]) assert.equal(f.find((x) => x.id === id)?.status, "warn", id);
  assert.ok(!ids(await withEnv({ MONOMEM_LINT: "quarantine" }, "127.0.0.1")).includes("lint-typo"));
});

test("MONOMEM_NO_CHMOD warns on POSIX only", async () => {
  const f = await withEnv({ MONOMEM_NO_CHMOD: "1" }, "127.0.0.1");
  assert.equal(ids(f).includes("no-chmod"), process.platform !== "win32");
});

test("trusting a proxy header is info on loopback and a warn on another bind", async () => {
  assert.equal((await withEnv({ MONOMEM_TRUST_PROXY: "1" }, "127.0.0.1")).find((x) => x.id === "trust-proxy")?.status, "info");
  assert.equal((await withEnv({ MONOMEM_TRUST_CLOUDFLARE: "1" }, "0.0.0.0")).find((x) => x.id === "trust-proxy")?.status, "warn");
});
