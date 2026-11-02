// assertSafeExposure() is the fail-closed guard that refuses to open a
// non-loopback listener without an explicit MONOMEM_TOKEN. Deleting its
// throw would previously have failed no test; this covers it directly.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { assertSafeExposure } from "../src/config.js";

const SAVE = { bind: process.env.MONOMEM_BIND, tok: process.env.MONOMEM_TOKEN };

describe("assertSafeExposure", () => {
  afterEach(() => {
    if (SAVE.bind === undefined) delete process.env.MONOMEM_BIND;
    else process.env.MONOMEM_BIND = SAVE.bind;
    if (SAVE.tok === undefined) delete process.env.MONOMEM_TOKEN;
    else process.env.MONOMEM_TOKEN = SAVE.tok;
  });

  test("loopback bind without a token is fine (auto-token is enough locally)", () => {
    process.env.MONOMEM_BIND = "127.0.0.1";
    delete process.env.MONOMEM_TOKEN;
    assert.doesNotThrow(() => assertSafeExposure());
  });

  test("default bind (unset) is loopback and fine", () => {
    delete process.env.MONOMEM_BIND;
    delete process.env.MONOMEM_TOKEN;
    assert.doesNotThrow(() => assertSafeExposure());
  });

  test("non-loopback bind WITHOUT an explicit token is refused", () => {
    process.env.MONOMEM_BIND = "0.0.0.0";
    delete process.env.MONOMEM_TOKEN;
    assert.throws(() => assertSafeExposure(), /Refusing to bind/);
  });

  test("non-loopback bind WITH an explicit token is allowed", () => {
    process.env.MONOMEM_BIND = "0.0.0.0";
    process.env.MONOMEM_TOKEN = "deliberate-token";
    assert.doesNotThrow(() => assertSafeExposure());
  });

  test("a blank token does not count as explicit", () => {
    process.env.MONOMEM_BIND = "0.0.0.0";
    process.env.MONOMEM_TOKEN = "   ";
    assert.throws(() => assertSafeExposure(), /Refusing to bind/);
  });
});
