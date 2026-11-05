// Read and edit <data dir>/tokens.json for `monomem token add|list|remove`.
// Format: a JSON array of { token, scope, label, namespace? } (docs/token-namespaces.md), exactly what
// config.ts resolveTokens() loads. This file never prints or logs a token it did not just generate.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TokenScope = "read" | "write" | "admin";
export interface TokenRow {
  token: string;
  scope: TokenScope;
  label: string;
  namespace?: string;
}

export class TokenFileError extends Error {}

const SCOPES: readonly string[] = ["read", "write", "admin"];

function load(file: string): TokenRow[] {
  if (!existsSync(file)) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new TokenFileError(`${file} is not valid JSON; fix or remove it by hand first (nothing was changed).`);
  }
  if (!Array.isArray(arr)) throw new TokenFileError(`${file} is not a JSON array; fix it by hand first (nothing was changed).`);
  return arr as TokenRow[];
}

function save(file: string, rows: TokenRow[]): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file); // atomic; the new file keeps the tmp file's 0600 on POSIX (Windows ignores modes)
}

export function tokensPath(dataDir: string): string {
  return join(dataDir, "tokens.json");
}

/** Add a new random token. Returns it ONCE; only the caller can show it. */
export function addToken(dataDir: string, label: string, scope: string, namespace?: string): TokenRow {
  const name = label.trim();
  if (!name) throw new TokenFileError("--label is required (a short name for who uses this token).");
  if (!SCOPES.includes(scope)) throw new TokenFileError("--scope must be read, write or admin.");
  const ns = namespace?.trim();
  if (namespace !== undefined && !ns) throw new TokenFileError("--namespace must not be empty.");
  const file = tokensPath(dataDir);
  const rows = load(file);
  if (rows.some((r) => r?.label === name)) throw new TokenFileError(`A token labelled "${name}" already exists; pick another label or remove it first.`);
  const row: TokenRow = { token: randomBytes(32).toString("hex"), scope: scope as TokenScope, label: name, ...(ns ? { namespace: ns } : {}) };
  save(file, [...rows, row]);
  return row;
}

/** Labels, scopes and pins only: never the secret. */
export function listTokens(dataDir: string): Array<Omit<TokenRow, "token">> {
  return load(tokensPath(dataDir)).map(({ scope, label, namespace }) => ({ label, scope, ...(namespace ? { namespace } : {}) }));
}

/** True when a token with that label was removed. */
export function removeToken(dataDir: string, label: string): boolean {
  const file = tokensPath(dataDir);
  const rows = load(file);
  const kept = rows.filter((r) => r?.label !== label);
  if (kept.length === rows.length) return false;
  save(file, kept);
  return true;
}
