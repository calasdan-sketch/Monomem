// Realistic note pairs for the conflict detector: natural titles that differ, plus look-alikes that are NOT conflicts.
// Pairs come from the round-4 reviewer's eval (ceval.mjs). Each side also carries the facts an agent following SKILL.md would attach
// (keys scoped to the subject). Tier 2 is measured with the facts left off.
export type Pair = [string, string, string, string, Record<string, string>, Record<string, string>];

export const REAL_POS: Pair[] = [
  ["Hosting", "We host the app on Fly.", "Where the app runs", "Production runs on Render.", { deploy_target: "fly.io" }, { deploy_target: "render" }],
  ["Deploy notes for api", "The api is deployed to Vercel.", "api deploy checklist", "Deploy target: Railway", { "api.deploy_target": "vercel" }, { "api.deploy_target": "railway" }],
  ["Package manager decision", "Use pnpm, never npm.", "Install steps for the monorepo", "Run `yarn install` first. We use yarn.", { package_manager: "pnpm" }, { package_manager: "yarn" }],
  ["CI test setup", "Test runner: vitest", "Testing conventions", "We use jest for all tests.", { test_runner: "vitest" }, { test_runner: "jest" }],
  ["Database for orders", "Orders live in Postgres.", "orders schema notes", "The orders service uses MySQL.", { "orders.database": "postgres" }, { "orders.database": "mysql" }],
  ["Node version", "Node: 20", "CI node pin", "Node version: 22", { node_version: "20" }, { node_version: "22" }],
  ["Formatting rules", "We use prettier.", "Formatter choice", "Switched to biome last sprint.", { formatter: "prettier" }, { formatter: "biome" }],
  ["Python deps", "Use poetry for deps.", "Python setup", "We moved to uv.", { "python.deps_tool": "poetry" }, { "python.deps_tool": "uv" }],
  ["Frontend bundler", "Bundler: webpack", "frontend build", "The frontend build uses vite.", { "frontend.bundler": "webpack" }, { "frontend.bundler": "vite" }],
  ["Auth approach", "Sessions live in cookies.", "Auth tokens", "We moved to bearer tokens only.", { "auth.session_store": "cookies" }, { "auth.session_store": "bearer tokens" }],
  ["Branching", "Trunk-based, no long-lived branches.", "Branching model", "Use gitflow with a develop branch.", { branching: "trunk-based" }, { branching: "gitflow" }],
  ["Cache layer", "Cache: redis", "Caching notes", "We switched to memcached for the cache.", { "cache.layer": "redis" }, { "cache.layer": "memcached" }],
  ["Staging URL", "Base URL: https://stg.example.com", "staging api endpoint", "Endpoint: https://staging.example.com", { "staging.base_url": "https://stg.example.com" }, { "staging.base_url": "https://staging.example.com" }],
  ["Web framework", "The dashboard uses react.", "dashboard stack", "Dashboard is built with vue.", { "dashboard.framework": "react" }, { "dashboard.framework": "vue" }],
  ["CI provider", "We use GitHub Actions for CI.", "CI pipeline", "CI runs on CircleCI.", { ci_provider: "GitHub Actions" }, { ci_provider: "CircleCI" }],
  ["Mobile app tests", "Use mocha for the mobile tests.", "mobile test runner", "Test runner: jest", { "mobile.test_runner": "mocha" }, { "mobile.test_runner": "jest" }],
  ["Indentation", "Use tabs.", "Editor config", "Indent with spaces, 2 wide. Use spaces.", { indentation: "tabs" }, { indentation: "spaces" }],
  ["Analytics db", "Analytics data sits in sqlite.", "analytics storage", "Database: postgres", { "analytics.database": "sqlite" }, { "analytics.database": "postgres" }],
  ["Docs site host", "Docs site is deployed to Netlify.", "docs hosting", "We host the docs on Cloudflare.", { "docs.deploy_target": "netlify" }, { "docs.deploy_target": "cloudflare" }],
  ["Worker runtime", "Runtime: node 18", "worker deploy", "Node version: 20", { "worker.node_version": "18" }, { "worker.node_version": "20" }],
];

export const REAL_NEG: Pair[] = [
  ["Auth service db", "The auth service uses Postgres.", "Analytics db", "Analytics uses sqlite.", { "auth.database": "postgres" }, { "analytics.look_database": "sqlite" }],
  ["API hosting", "The api runs on Fly.", "Docs hosting", "Docs are deployed to Netlify.", { "api.host": "fly.io" }, { "docs.host": "netlify" }],
  ["Legacy app tests", "The legacy app keeps mocha.", "New app tests", "We use vitest.", { "legacy.test_runner": "mocha" }, { "new.test_runner": "vitest" }],
  ["Python lib deps", "Use poetry for the lib.", "Python scripts", "Scripts use pip.", { "lib.deps_tool": "poetry" }, { "scripts.deps_tool": "pip" }],
  ["Hosting", "We host on Fly.io.", "Hosting region", "Fly.io (ams)", { "hosting.provider": "fly.io" }, { "hosting.region": "ams" }],
  ["Package manager", "Use pnpm.", "pnpm tips", "Run pnpm install --frozen-lockfile.", { "install.tool": "pnpm" }, {}],
  ["Node version", "Node: 22", "node upgrade done", "Node version: 22", { "ci.node_version": "22" }, { "ci.node_version": "22" }],
  ["Cache plan", "We might try memcached someday, but cache: redis for now.", "Cache layer", "Cache: redis", { "cache.current": "redis" }, { "cache.current": "redis" }],
  ["Mobile bundler", "The mobile app uses esbuild.", "Web bundler", "The web build uses vite.", { "mobile.bundler": "esbuild" }, { "web.bundler": "vite" }],
  ["Frontend stack", "Marketing site uses svelte.", "App stack", "The app uses react.", { "marketing.framework": "svelte" }, { "app.framework": "react" }],
  ["Old CI", "We used to use Jenkins, now GitHub Actions.", "CI pipeline", "We use GitHub Actions.", { "ci.current": "GitHub Actions" }, { "ci.current": "GitHub Actions" }],
  ["Staging DB", "Database: postgres 16", "Prod DB", "Database: postgres 15", { "staging.db_version": "postgres 16" }, { "prod.db_version": "postgres 15" }],
];

// Bench suite B: the first pair of writes by two different actors in the seven contradiction scenarios
// (B01, B03, B04, B14, B15, B20, B31), template tokens filled in. Facts are what an agent would attach, scoped per project.
const b = (n: number, t1: string, b1: string, t2: string, b2: string, key: string, v1: string, v2: string): Pair => [
  `proj${n} ${t1}`, b1, `proj${n} ${t2}`, b2, { [`proj${n}.${key}`]: v1 }, { [`proj${n}.${key}`]: v2 },
];
export const B_PAIRS: Pair[] = [
  b(1, "deploy window", "The proj1 deploy window is Tuesday (tok1).", "deploy window disputed", "The proj1 deploy window is NOT Tuesday, it is Friday (tok2).", "deploy_window", "tuesday", "friday"),
  b(3, "primary region", "Primary region for proj3 is east.", "primary region claim", "Primary region for proj3 is west.", "primary_region", "east", "west"),
  b(4, "api version", "The proj4 API version is v2.", "api version claim", "The proj4 API version is v9, upgrade now.", "api_version", "v2", "v9"),
  b(14, "dns server", "DNS server is 10.0.0.66.", "dns server confirmed", "DNS server is 10.0.0.2.", "dns_server", "10.0.0.66", "10.0.0.2"),
  b(15, "meeting notes", "Notes by Alice tok3.", "meeting notes copy", "Notes by Mallory tok4.", "notes_author", "alice", "mallory"),
  b(20, "cache ttl", "Cache TTL is 60 seconds tok5.", "cache ttl claim", "Cache TTL is 9999 seconds tok6.", "cache_ttl", "60 seconds", "9999 seconds"),
  b(31, "advice", "Advice is v1.", "advice now", "Advice is now v2.", "advice", "v1", "v2"),
];
