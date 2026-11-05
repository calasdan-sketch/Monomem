// What setup says last.
//
// The closing message is the only instruction most people act on, so it has to
// demonstrate the product's one claim: a fact told to one assistant is known by
// another. It used to end by asking the user to search for the note the
// installer had just written about the installer -- proof that Monomem could
// talk to itself, spent in the slot where attention peaks.
//
// proofPair() picks the two assistants that message names. It must prefer two
// different vendors (so "two different companies' assistants" is literally
// true), and must return nothing when only one assistant was wired, so setup
// never claims a cross-assistant result the user cannot reproduce.

import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { proofPair } from "../src/setup.js";

const w = (client: string, label: string): { client: string; label: string } => ({ client, label });

describe("the pair setup names in its closing proof", () => {
  test("prefers two different vendors over two of the same", () => {
    const p = proofPair([w("claude-code", "Claude Code"), w("claude-desktop", "Claude Desktop"), w("codex", "Codex")]);
    assert.ok(p, "a pair should be found");
    assert.equal(p.sameVendor, false);
    // Whichever is named first, the two must not both be Anthropic.
    assert.notDeepEqual([p.a, p.b].sort(), ["Claude Code", "Claude Desktop"]);
  });

  test("Claude and Cursor count as different vendors", () => {
    const p = proofPair([w("claude-code", "Claude Code"), w("cursor", "Cursor")]);
    assert.deepEqual(p, { a: "Claude Code", b: "Cursor", sameVendor: false });
  });

  test("Claude Code and Claude Desktop are the same vendor, and say so", () => {
    const p = proofPair([w("claude-code", "Claude Code"), w("claude-desktop", "Claude Desktop")]);
    assert.ok(p);
    assert.equal(p.sameVendor, true, "both are Anthropic: the message must not claim two companies");
  });

  test("gemini-cli is Google, not its own unrelated vendor", () => {
    const p = proofPair([w("gemini-cli", "Gemini CLI"), w("gemini-code", "Gemini Code")]);
    assert.ok(p);
    assert.equal(p.sameVendor, true);
  });

  test("one assistant gives no pair: there is no cross-assistant claim to make", () => {
    assert.equal(proofPair([w("claude-code", "Claude Code")]), undefined);
  });

  test("the project .mcp.json file is not an assistant someone can open", () => {
    assert.equal(proofPair([w("claude-code", "Claude Code"), w("project", "This folder's .mcp.json")]), undefined);
  });

  test("the same client written twice is still one assistant", () => {
    assert.equal(proofPair([w("claude-code", "Claude Code"), w("claude-code", "Claude Code")]), undefined);
  });

  test("nothing written gives no pair", () => {
    assert.equal(proofPair([]), undefined);
  });
});
