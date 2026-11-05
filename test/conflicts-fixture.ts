// A mixed store of ~200 developer notes from three writers, with planted conflicts and look-alike non-conflicts.
// Deterministic (no randomness). Used by conflicts.test.ts to measure precision and recall.
import { Store } from "../src/store.js";

const DAY = 86_400_000;
const ago = (d: number): string => new Date(Date.now() - d * DAY).toISOString();

export interface Fixture { store: Store; planted: Array<[number, number]>; missed: Array<[number, number]> }

export function buildFixture(): Fixture {
  const store = new Store(":memory:");
  let day = 300;
  const add = (writer: string, title: string, body: string, ns = "default"): number => {
    day -= 0.5;
    return store.create({ title, body, namespace: ns }, { writtenBy: writer, updatedAt: ago(day) }).id;
  };
  const W = ["alice", "bob", "carol"];

  // 60 services, each with the same field names but different subjects: shared keys, NOT conflicts.
  const svcs = ["auth", "billing", "search", "mailer", "gateway", "cart", "catalog", "reports", "uploads", "notify", "audit", "export", "import", "sync", "cron", "queue", "cache", "geo", "ledger", "orders", "payments", "profile", "inbox", "tasks", "wiki", "feed", "media", "chat", "admin", "docs", "metrics", "logs", "flags", "limits", "tokens", "sessions", "teams", "invites", "plans", "usage", "quotas", "webhooks", "hooks", "jobs", "batch", "stream", "bridge", "proxy", "edge", "static", "labels", "tags", "search-ui", "mobile-api", "web-ui", "admin-ui", "etl", "cdn", "dns"];
  svcs.forEach((s, i) => add(W[i % 3], `${s} service runbook`, `Port: ${3000 + i}\nOwner: team-${i % 7}\nRuntime: node ${18 + (i % 3) * 2}\nTimeout: ${10 + i}s`));
  // 40 prose notes: no key lines.
  const prose = ["retry with backoff when the queue is full", "never log tokens in clear text", "prefer small commits and rebase before merge", "the nightly job needs a lock to avoid overlap", "run the linter before pushing", "keep migrations reversible", "cache invalidation happens on write", "use feature flags for risky rollouts"];
  for (let i = 0; i < 40; i++) add(W[i % 3], `Learning ${i}: ${prose[i % 8].split(" ").slice(0, 3).join(" ")} ${i}`, `We learned that we should ${prose[i % 8]}. Case ${i} confirmed it. See the postmortem thread for more detail.`);
  // 30 one-writer revisions of the same fact (history by one author, not a disagreement between writers).
  for (let i = 0; i < 15; i++) { add("alice", `Release cadence ${i}: weekly`, "Cadence: weekly"); add("alice", `Release cadence ${i}: every two weeks`, "Cadence: every two weeks"); }
  // 40 agreeing pairs from different writers.
  for (let i = 0; i < 20; i++) { add("alice", `Region ${i}: eu-west-${i}`, `Region: eu-west-${i}`); add("bob", `Region ${i}: eu-west-${i}`, `Region: eu-west-${i}`); }
  // 16 "use X for Y" decisions in different contexts.
  const ctx = ["unit tests", "e2e tests", "the web build", "the api build", "docs", "lint", "formatting", "the mobile app"];
  ctx.forEach((c, i) => { add("alice", `Decision: use vitest for ${c}`, `We use vitest for ${c}.`); add("bob", `Decision: use mocha for ${c} in legacy-${i}`, `legacy-${i} keeps mocha.`); });
  // 6 notes with colons in prose or URL lines.
  add("bob", "Docs links", "See: https://example.com/a\nSee: https://example.com/b");
  add("carol", "Meeting recap", "Note: ship friday\nTodo: write the doc");
  add("alice", "Standup", "Note: nothing blocked\nTodo: review prs");
  add("bob", "Links 2", "Home: https://example.com\n");
  add("carol", "Links 3", "Home: https://example.org\n");
  add("alice", "Readme tips", "Tip: keep it short\n");

  // Planted real conflicts (different writers, same subject, different value for the same key).
  const planted: Array<[number, number]> = [];
  const pair = (t1: string, b1: string, t2: string, b2: string, w: [string, string] = ["alice", "bob"]): void => { planted.push([add(w[0], t1, b1), add(w[1], t2, b2)]); };
  pair("Deploy target: Fly.io", "Deploy target: Fly.io", "Deploy target: Render", "Deploy target: Render");
  pair("Package manager", "Use pnpm", "Package manager", "Use npm");
  pair("Use pnpm", "We use pnpm everywhere.", "Use npm", "We use npm everywhere.");
  pair("Production database", "Database: postgres 15", "Production database", "Database: postgres 16");
  pair("API base URL", "Base URL: https://api.example.com/v1", "API base URL", "Base URL: https://api.example.com/v2");
  pair("Staging hostname", "Host: stg-1.example.net", "Staging hostname", "Host: stg-2.example.net");
  pair("Request timeout policy", "Timeout: 30s", "Request timeout policy", "Timeout: 60s");
  pair("Node version for CI", "Node version: 20", "Node version for CI", "Node version: 22");
  pair("Indentation style", "Use tabs.", "Indentation style", "Use spaces.");
  pair("Test runner choice", "Test runner: vitest", "Test runner choice", "Test runner: jest", ["carol", "alice"]);
  pair("Cache TTL", "TTL: 5 minutes", "Cache TTL", "TTL: 1 hour", ["bob", "carol"]);
  pair("Decision: use jest for api tests", "x", "Decision: use vitest for api tests", "y");
  // Real conflicts a deterministic key matcher cannot see (paraphrase): counted as misses, honestly.
  const missed: Array<[number, number]> = [];
  missed.push([add("alice", "Hosting", "We host the app on Fly."), add("bob", "Where the app runs", "Production runs on Render.")]);
  missed.push([add("alice", "Auth approach", "Sessions live in cookies."), add("carol", "Auth approach", "We moved to bearer tokens only.")]);
  missed.push([add("bob", "Branching", "Trunk-based, no long-lived branches."), add("carol", "Branching model", "Use gitflow with a develop branch.")]);
  return { store, planted, missed };
}
