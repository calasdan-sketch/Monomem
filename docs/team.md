# Shared memory for a team

One Monomem server, one token per person, and every note says who wrote it. This page is the short recipe. Each
step links to the page that has the detail.

What you get: a teammate's agent can read what the team has written down, you can see which person's assistant wrote
each note, and a write that looks like a planted instruction waits for a human instead of reaching everyone's agents.
What you do not get: Monomem has no user accounts, no sign-in page and no per-note permissions. A token is a password
that belongs to one person, and the namespace it is pinned to is the only fence.

## 1. Run it in HTTP mode, behind something that checks who is calling

```bash
export MONOMEM_TOKEN=$(openssl rand -hex 32)   # the admin token, yours
export MONOMEM_BIND=0.0.0.0                    # only if the server must listen beyond this machine
monomem start                                  # dashboard + REST on :8790, MCP over HTTP on :8791 (/mcp)
```

By default the server listens on `127.0.0.1` only. It refuses to bind to anything else unless `MONOMEM_TOKEN` is set.
Do not put the plain port on the internet. Put an authenticated tunnel or a TLS proxy in front of it; the three checks
and the Cloudflare Access setup are in [INFRA.md](../INFRA.md).

## 2. One token per person

Give each person their own token, so the writer name on a note is that person. Add them to
`~/.monomem/tokens.json` (the folder `monomem doctor` reports; set `MONOMEM_TOKENS` instead if you run in Docker):

```json
[
  { "token": "<64 random hex characters>", "scope": "write", "label": "alice", "namespace": "team" },
  { "token": "<another one>",              "scope": "write", "label": "bob",   "namespace": "team" },
  { "token": "<another one>",              "scope": "read",  "label": "intern", "namespace": "team" }
]
```

Make each token with `openssl rand -hex 32`; Monomem ignores tokens shorter than 32 characters. The server reads this
file once at startup, so restart it after a change. Each person then points their assistant at
`https://<your host>/mcp` and sends their token as `Authorization: Bearer <token>`. Details for each client are in
[INSTALL.md](../INSTALL.md); n8n and other HTTP callers are in [INFRA.md](../INFRA.md).

> `monomem token add --label alice --scope write --namespace team` is planned so you do not have to edit the file
> by hand. It is not in this version; edit `tokens.json` as above.

`read` can only read, `write` can read and write, `admin` can also approve held writes and change policy. The
label becomes the note's `written_by`, which the server stamps itself; nobody can write as someone else
([docs/provenance.md](./provenance.md)).

## 3. Namespaces: who sees what

A token with a `namespace` is confined to it: it writes there, reads there, and cannot see or touch another
namespace (a miss looks like "not found", not "forbidden"). Give everyone the same `team` namespace to share
notes, and add a personal namespace per person for what should stay private. Letting one namespace read another is
set by you in the operator's spaces file, never by a token. All of it: [docs/token-namespaces.md](./token-namespaces.md).

Keep one admin token that is not pinned (the primary `MONOMEM_TOKEN`). It sees every namespace and is the one you
use for review.

## 4. Approve-first for the shared namespace

For a namespace everyone reads, make every agent write wait for a person:

```bash
monomem approve-first team on     # agent writes to "team" now wait for approval
monomem approve-first             # list the namespaces that have it on
```

Held writes show in the dashboard's **Held** tab (admin token) and in `monomem quarantine list`; approve or reject each
one. This is on top of the linter, which holds writes that look like secrets or injected instructions even without
approve-first. The linter is pattern matching and misses things, so approve-first is the stronger setting. Notes
you write yourself with the `monomem` command are not held. See [docs/memory-linter.md](./memory-linter.md).

If one person's agent starts writing things the team should not trust, an admin can stop their notes reaching
anyone's session: `monomem trust distrust alice --namespace team` ([docs/trust.md](./trust.md)).

## 5. Keeping copies

**Backups of the server.** `monomem backup --out ~/om-backup` makes a consistent copy while the server runs. If you
turned on encryption at rest, keep the key file apart from the backup. Detail: [INFRA.md](../INFRA.md#7-backups).

**Without a server at all.** If your team is small and trusts a private git repository, each person can keep their
own local store and run `monomem sync --git <repo-folder> --encrypt` to merge through that repository. Nobody needs a
shared server for this, and it is not the same thing as steps 1 to 4: each computer has its own copy, there are no
approve-first holds across computers, and deleting a note does not remove it from the other computers. See
[docs/file-sync.md](./file-sync.md#git-in-one-command-sync---git).

## A short checklist

- [ ] Server is behind a tunnel or proxy that checks who is calling, and `MONOMEM_TOKEN` is set.
- [ ] One token per person, each with a `label` and a `namespace`.
- [ ] `approve-first` is on for the shared namespace, and someone owns the Held tab.
- [ ] A backup runs on a schedule, and the encryption key (if any) is stored apart from it.
