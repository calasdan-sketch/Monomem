// Which Node versions Monomem accepts.
//
// TWO capabilities are needed and they arrived at different times, so a single
// ">= x.y" rule is wrong:
//
//   1. `node:sqlite` importable with no flag -- notes are stored through it.
//      src/config.ts imports it at the top level, so a miss is a load-time
//      crash: ERR_UNKNOWN_BUILTIN_MODULE, before any Monomem code runs.
//   2. SQLite built WITH FTS5 -- every search goes through an FTS5 table, so a
//      miss is ERR_SQLITE_ERROR "no such module: fts5" on the first query.
//
// Measured on official nodejs.org builds, not inferred from release notes:
//
//   22.5.0 - 22.12.x    node:sqlite behind --experimental-sqlite  -> refuse
//   22.13.0 - 22.15.x   node:sqlite unflagged, but NO FTS5        -> refuse
//   22.16.0+            both                                      -> accept
//   23.x (all of it)    no FTS5 even in 23.11.1, the last release -> refuse
//   24.0.0+             both                                      -> accept
//
// Node 23 is the reason this cannot be "newer is fine": 23.11.1 is newer than
// 22.16.0 and still cannot run a single search. 23 was never LTS and is EOL.
//
// This gate has been wrong three times. It demanded 24 (locking out all of LTS
// 22); then 2.1.1 said 22.5.0 (load-time crash on 22.5-22.12) and this suite
// asserted exactly that, so it was green on a bug; then 22.13.0 (FTS5 crash on
// 22.13-22.15), caught only once CI pinned the floor and actually ran it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { nodeIsOk, MIN_NODE_TEXT } from "../src/setup.js";

describe("the Node version floor is 22.16.0, and Node 23 is excluded outright", () => {
  test("every Node with both node:sqlite and FTS5 is accepted", () => {
    for (const v of ["22.16.0", "22.17.0", "22.20.0", "22.23.1", "24.0.0", "24.18.0", "25.1.0", "26.0.0"]) {
      assert.equal(nodeIsOk(v), true, `${v} has node:sqlite with FTS5 and must be accepted`);
    }
  });

  test("22.13 through 22.15 are refused: node:sqlite imports, but SQLite has no FTS5", () => {
    for (const v of ["22.13.0", "22.14.0", "22.15.0", "22.15.9"]) {
      assert.equal(nodeIsOk(v), false, `${v} has no FTS5, so every search would fail: it must be refused`);
    }
  });

  test("22.5 through 22.12 are refused: node:sqlite needs --experimental-sqlite", () => {
    for (const v of ["22.5.0", "22.6.0", "22.9.0", "22.11.0", "22.12.0", "22.12.9"]) {
      assert.equal(nodeIsOk(v), false, `${v} throws ERR_UNKNOWN_BUILTIN_MODULE at load: it must be refused`);
    }
  });

  test("Node 22 before 22.5.0 is refused: node:sqlite does not exist at all", () => {
    for (const v of ["22.0.0", "22.1.0", "22.4.0", "22.4.9"]) {
      assert.equal(nodeIsOk(v), false, `${v} has no node:sqlite and must be refused`);
    }
  });

  test("the whole Node 23 line is refused, including its last release", () => {
    for (const v of ["23.0.0", "23.5.0", "23.10.0", "23.11.0", "23.11.1"]) {
      assert.equal(nodeIsOk(v), false, `${v} ships SQLite without FTS5, so no search works: it must be refused`);
    }
  });

  test("older lines are refused", () => {
    for (const v of ["18.20.0", "20.0.0", "20.19.5", "21.7.3"]) {
      assert.equal(nodeIsOk(v), false, `${v} must be refused`);
    }
  });

  test("a version string with a prerelease or v prefix still parses", () => {
    assert.equal(nodeIsOk("v22.16.0"), true);
    assert.equal(nodeIsOk("24.0.0-nightly20240101"), true);
    assert.equal(nodeIsOk("v22.15.0"), false);
    assert.equal(nodeIsOk("v23.11.1"), false);
  });

  test("junk is refused rather than treated as new enough", () => {
    for (const v of ["", "abc", "x.y.z", "22", "22.x"]) {
      assert.equal(nodeIsOk(v), false, `${JSON.stringify(v)} must not pass the gate`);
    }
  });

  test("the message users see names the real floor", () => {
    assert.match(MIN_NODE_TEXT, /^22\.16\.0$/);
  });
});
