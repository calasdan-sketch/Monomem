// Which Node versions OneMemory accepts.
//
// OneMemory stores notes in SQLite through Node's built-in `node:sqlite`.
// TWO versions matter, and only the later one is the floor:
//
//   22.5.0   `node:sqlite` was ADDED -- but only behind `--experimental-sqlite`
//   22.13.0  the flag requirement was REMOVED, so a plain import works
//
// src/config.ts imports `node:sqlite` at the top level, so on 22.5-22.12 the
// process dies at load with ERR_UNKNOWN_BUILTIN_MODULE before any of our code
// runs. 2.1.1 shipped 22.5.0 as the floor and this suite asserted it, so the
// tests were green on the wrong invariant: `engines` only warns, which meant
// a user on 22.5-22.12 installed cleanly and then crashed on the first command.
//
// The check has to read the MINOR version: a major-only comparison would wave
// through every one of those broken 22.x releases.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { nodeIsOk, MIN_NODE_TEXT } from "../src/setup.js";

describe("the Node version floor is 22.13.0", () => {
  test("every Node that can import node:sqlite unflagged is accepted", () => {
    for (const v of ["22.13.0", "22.14.0", "22.23.1", "23.0.0", "23.11.0", "24.0.0", "24.18.0", "25.1.0"]) {
      assert.equal(nodeIsOk(v), true, `${v} imports node:sqlite with no flag and must be accepted`);
    }
  });

  test("22.5 through 22.12 are refused: node:sqlite exists but needs --experimental-sqlite", () => {
    for (const v of ["22.5.0", "22.6.0", "22.9.0", "22.11.0", "22.12.0", "22.12.9"]) {
      assert.equal(
        nodeIsOk(v),
        false,
        `${v} needs --experimental-sqlite, so a plain import throws ERR_UNKNOWN_BUILTIN_MODULE: it must be refused`,
      );
    }
  });

  test("Node 22 before 22.5.0 is refused: node:sqlite does not exist at all", () => {
    for (const v of ["22.0.0", "22.1.0", "22.4.0", "22.4.9"]) {
      assert.equal(nodeIsOk(v), false, `${v} has no node:sqlite and must be refused`);
    }
  });

  test("older lines are refused", () => {
    for (const v of ["18.20.0", "20.0.0", "20.19.5", "21.7.3"]) {
      assert.equal(nodeIsOk(v), false, `${v} must be refused`);
    }
  });

  test("a version string with a prerelease or v prefix still parses", () => {
    assert.equal(nodeIsOk("v22.13.0"), true);
    assert.equal(nodeIsOk("24.0.0-nightly20240101"), true);
    assert.equal(nodeIsOk("v22.12.0"), false);
    assert.equal(nodeIsOk("v22.4.0"), false);
  });

  test("junk is refused rather than treated as new enough", () => {
    for (const v of ["", "abc", "x.y.z", "22", "22.x"]) {
      assert.equal(nodeIsOk(v), false, `${JSON.stringify(v)} must not pass the gate`);
    }
  });

  test("the message users see names the real floor", () => {
    // Printed by setup and by the CLI guard. Must say 22.13.0: not 24 (which
    // locked out the whole 22 line) and not 22.5.0 (which lets a crash in).
    assert.match(MIN_NODE_TEXT, /^22\.13\.0$/);
  });
});
