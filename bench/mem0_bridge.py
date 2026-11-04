"""JSON-lines bridge between the TypeScript benchmark adapter and Mem0 open source (pip package mem0ai).

One request per stdin line, one response per stdout line: {"ok": true, "result": ...} or {"ok": false, "error": "..."}.
Everything runs locally: Ollama LLM + Ollama embeddings + Mem0's default local Qdrant (on disk, no server).
Mem0 telemetry must be off: the adapter starts this with MEM0_TELEMETRY=False and MEM0_DIR in a temp folder.
Internal comparison tooling; see src/bench/competitors/mem0-adapter.ts.
"""
import json
import os
import shutil
import sys

out = sys.stdout
sys.stdout = sys.stderr  # library prints must never corrupt the protocol

assert os.environ.get("MEM0_TELEMETRY", "").lower() in ("false", "0", "no"), "set MEM0_TELEMETRY=False"

from mem0 import Memory  # noqa: E402

OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
LLM = os.environ.get("MEM0_BENCH_LLM", "qwen2.5:7b")
USER = "bench"  # one shared memory: Mem0 scopes by caller-supplied ids, it has no credentials
mem = None
folder = None


def close():
    global mem, folder
    if mem is not None:
        try:
            mem.vector_store.client.close()
        except Exception:
            pass
        mem = None
    if folder:
        shutil.rmtree(folder, ignore_errors=True)
        folder = None


def handle(req):
    global mem, folder
    op = req["op"]
    if op == "open":
        close()
        folder = req["dir"]
        mem = Memory.from_config({
            "llm": {"provider": "ollama", "config": {"model": LLM, "temperature": 0, "ollama_base_url": OLLAMA}},
            "embedder": {"provider": "ollama", "config": {"model": "nomic-embed-text", "ollama_base_url": OLLAMA}},
            "vector_store": {"provider": "qdrant", "config": {"collection_name": "bench", "path": os.path.join(folder, "qdrant"), "embedding_model_dims": 768, "on_disk": True}},
            "history_db_path": os.path.join(folder, "history.db"),
        })
        return None
    if op == "close":
        close()
        return None
    if op == "add":
        return mem.add(req["text"], user_id=USER, metadata=req.get("metadata") or None, infer=req["infer"])["results"]
    if op == "search":
        return mem.search(req["query"], top_k=req.get("limit", 10), filters={"user_id": USER})["results"]
    if op == "get":
        return mem.get(req["id"])
    if op == "list":
        return mem.get_all(filters={"user_id": USER}, top_k=1000)["results"]
    if op == "update":
        return mem.update(req["id"], text=req.get("text"), metadata=req.get("metadata"))
    if op == "delete":
        return mem.delete(req["id"])
    if op == "history":
        return mem.history(req["id"])
    raise ValueError(f"unknown op {op}")


for line in sys.stdin:
    try:
        res = {"ok": True, "result": handle(json.loads(line))}
    except Exception as e:  # report, never die: the adapter maps it to an "error" outcome
        res = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    out.write(json.dumps(res, default=str) + "\n")
    out.flush()
close()
