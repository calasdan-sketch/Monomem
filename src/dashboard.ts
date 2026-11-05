// A tiny self-contained dashboard served at GET "/" so you can browse, search,
// add, and delete notes in the shared store from a browser. No framework, no
// external requests -- just vanilla HTML/CSS/JS. The page itself is public
// (it holds no data); every data call it makes carries the bearer token the
// user pastes once (kept in sessionStorage for that tab only).

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>monomem</title>
<link rel="icon" href="/favicon.ico" type="image/png">
<style>
  /* Brand: navy #0B2E45 + gold #F0C171. Every colour is a token; the light theme only redefines tokens. */
  :root{color-scheme:dark;--gold:#F0C171;
    --bg:#061a28;--panel:#0B2E45;--panel2:#143c58;--line:#2a5878;--field-line:#6b93ae;
    --ink:#eef3f7;--dim:#a9bfcf;--body:#d3e0ea;--accent:#F0C171;--focus:#F0C171;
    --btn-bg:#F0C171;--btn-fg:#0B2E45;--danger:#ffa3a3;--danger-bg:#b3261e;--danger-fg:#fff;
    --chip-s:45%;--chip-bg-l:24%;--chip-fg-l:86%;--chip-fg-s:80%}
  @media (prefers-color-scheme:light){:root{color-scheme:light;
    --bg:#f3f6f9;--panel:#ffffff;--panel2:#e6edf3;--line:#c3d1dc;--field-line:#6b879b;
    --ink:#0B2E45;--dim:#46607a;--body:#1d3b50;--accent:#7a4f00;--focus:#0B2E45;
    --btn-bg:#0B2E45;--btn-fg:#ffffff;--danger:#b3261e;--danger-bg:#b3261e;--danger-fg:#fff;
    --chip-s:60%;--chip-bg-l:90%;--chip-fg-l:20%;--chip-fg-s:70%}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{display:flex;gap:10px;align-items:center;padding:12px max(16px,calc((100% - 900px)/2 + 16px));
    border-bottom:3px solid var(--gold);background:var(--bg);flex-wrap:wrap}
  @media (min-width:700px){header{position:sticky;top:0;z-index:2}}
  h1{font-size:16px;margin:0;font-weight:700;letter-spacing:.2px}
  h1 span{color:var(--accent)}
  input,textarea,button,select{font:inherit;color:var(--ink);background:var(--panel);
    border:1px solid var(--field-line);border-radius:9px;padding:6px 11px;min-height:34px}
  :focus-visible{outline:3px solid var(--focus);outline-offset:2px}
  button{cursor:pointer;background:var(--btn-bg);border-color:var(--btn-bg);color:var(--btn-fg);font-weight:600}
  button.ghost{background:var(--panel);color:var(--ink);border-color:var(--field-line)}
  button.danger{background:transparent;border-color:transparent;color:var(--danger);padding:4px 8px}
  button.linkbtn{background:none;border:0;color:var(--accent);text-decoration:underline;
    padding:4px 2px;font-weight:400}
  nav{display:flex;gap:6px;flex-wrap:wrap;padding:10px 16px 0;max-width:900px;margin:0 auto}
  nav button{background:transparent;color:var(--ink);border-color:var(--line);font-weight:500}
  [hidden]{display:none!important}
  nav button.lit{border-color:var(--danger)}
  .pill{display:inline-block;background:var(--danger-bg);color:var(--danger-fg);border-radius:999px;
    padding:0 7px;font-size:11px;font-weight:700;margin-left:6px;line-height:17px}
  .strip{display:block;width:100%;text-align:left;margin-bottom:12px;background:transparent;color:var(--danger);
    border:1px solid var(--danger);border-left:5px solid var(--danger-bg);border-radius:9px;font-weight:600}
  .card.held{border-left:5px solid var(--danger-bg)}
  .stamp{display:inline-block;border:2px solid var(--danger);color:var(--danger);border-radius:4px;
    padding:0 7px;font-size:11px;font-weight:800;letter-spacing:.08em;margin-bottom:6px}
  .heldbody{font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;white-space:pre-wrap;
    overflow-wrap:anywhere;color:var(--body);border:1px dashed var(--danger);border-radius:6px;padding:8px 10px;margin-top:8px}
  nav button[aria-current=page]{background:var(--panel2);border-color:var(--accent);
    box-shadow:inset 0 -3px 0 var(--accent);font-weight:700}
  .grow{flex:1 1 140px;min-width:0}
  .ns{width:130px;max-width:100%}
  main{max-width:900px;margin:0 auto;padding:14px 16px 18px}
  .row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
    padding:14px 16px;margin-bottom:12px}
  .card h3{margin:0 0 4px;font-size:15px;overflow-wrap:anywhere}
  .meta{color:var(--dim);font-size:12px;margin-bottom:8px;overflow-wrap:anywhere}
  .tag{display:inline-block;background:var(--panel2);border:1px solid var(--line);
    border-radius:999px;padding:1px 9px;font-size:12px;margin:0 5px 3px 0;color:var(--dim)}
  .tag.why{color:var(--ink);border-color:var(--danger)}
  .chip{display:inline-block;border-radius:6px;padding:0 7px;font-size:12px;font-weight:600;
    background:hsl(var(--h) var(--chip-s) var(--chip-bg-l));color:hsl(var(--h) var(--chip-fg-s) var(--chip-fg-l))}
  .badge-pin{display:inline-block;background:var(--gold);color:#0B2E45;border-radius:6px;
    padding:0 7px;font-size:11px;font-weight:700;margin-left:6px;vertical-align:middle}
  .body{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--body);font-size:14px}
  .cardhead{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}
  .cardhead>div:first-child{flex:1 1 220px;min-width:0}
  #new textarea{width:100%;min-height:70px;resize:vertical}
  #new{display:none}
  .muted{color:var(--dim)}
  .err{color:var(--danger)}
  .msg{min-height:0;margin-bottom:10px}
  .msg:empty{display:none}
  .gate{max-width:420px;margin:12vh auto;padding:0 16px;text-align:center}
  .gate input{width:100%;margin:12px 0;text-align:center}
  footer{max-width:900px;margin:0 auto;padding:10px 16px 40px;color:var(--dim);
    font-size:12px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
  .badge-bad{display:inline-block;background:var(--danger-bg);color:var(--danger-fg);border-radius:6px;
    padding:0 7px;font-size:11px;font-weight:700;margin-left:6px;vertical-align:middle}
  #runner div+div{margin-top:4px}
  label.chk{display:flex;gap:6px;align-items:center;color:var(--dim);font-size:13px;white-space:nowrap}
  .scroll{overflow-x:auto}
  .msg{overflow-wrap:anywhere}
  .cf{border-top:1px solid var(--line);padding:10px 0 2px}
  .cf h3{margin:0 0 6px}
  .cfval{margin:6px 0}
  .cfmore{margin-top:6px}
  .cfdlg:empty{display:none}
  .cfdlg{margin-top:8px;padding:8px 10px;border:1px solid var(--line);border-radius:6px}
  .cfdlg ul{margin:0 0 6px;padding-left:18px}
  .cf .acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .cf .acts button{max-width:100%;overflow-wrap:anywhere}
  /* Phones: the note text comes before its action buttons. */
  @media (max-width:600px){
    header h1{order:-2}
    header label.chk{order:-1;margin-left:auto} /* the checkbox shares the title's row instead of wrapping alone */
    .card{display:flex;flex-direction:column}
    .cardhead{display:contents}
    .cardhead>div:first-child{order:1;flex:none}
    .card>.body,.card>.heldbody{order:2}
    .card .acts{order:3;margin-top:10px}
  }
  code{background:var(--panel2);border-radius:4px;padding:0 4px}
</style>
</head>
<body>
<div id="app" style="display:none">
<header>
  <h1>mono<span>mem</span></h1>
  <input id="q" class="grow" aria-label="Search notes" placeholder="Search notes...">
  <input id="ns" class="ns" aria-label="Namespace filter" placeholder="namespace">
  <button class="ghost" onclick="toggleNew()">+ New</button>
  <button class="ghost" onclick="load()">Refresh</button>
  <label class="chk" title="Also show notes written by writers an admin distrusts (marked DISTRUSTED)"><input type="checkbox" id="inc" onchange="load()"> distrusted</label>
</header>
<nav aria-label="Views">
  <button id="tab_list" onclick="load()" title="All notes, newest first">Notes</button>
  <button id="tab_held" onclick="loadHeld()" title="Writes held out of shared memory until you approve or reject them: ones the linter flagged (secrets, injected instructions) and ones written to an approve-first namespace (admin token)">Held<span id="held_n"></span></button>
  <button id="tab_review" onclick="loadReview()" title="Notes written by agents that you have not looked at yet">Review</button>
  <button id="tab_changes" onclick="loadChanges()" title="What changed in the last 24 hours">Changes</button>
  <button id="tab_sessions" onclick="loadSessions()" title="Agent sessions Monomem recorded, each with its timeline">Sessions</button>
  <button id="tab_quality" onclick="loadQuality()" title="Duplicates, stale twins, held writes, linter findings and rows about to decay (admin token)">Quality</button>
  <button id="tab_meter" onclick="loadMeter()" title="What Monomem costs you: tokens injected and saved, local-model tokens, database size">Meter</button>
</nav>
<main>
  <div id="new" class="card">
    <div class="row">
      <input id="n_title" class="grow" aria-label="Title" placeholder="Title">
      <input id="n_ns" class="grow" aria-label="Namespace (optional)" placeholder="namespace (optional)">
      <input id="n_tags" class="grow" aria-label="Tags, comma separated" placeholder="tags, comma, separated">
    </div>
    <textarea id="n_body" aria-label="Body" placeholder="Body..."></textarea>
    <div class="row" style="margin-top:10px">
      <button onclick="addNote()">Save note</button>
      <span id="n_err" class="err" role="alert"></span>
    </div>
  </div>
  <div id="msg" class="msg" role="status" aria-live="polite"></div>
  <div id="runner" class="card err" style="display:none"></div>
  <button id="heldstrip" class="strip" onclick="loadHeld()" hidden></button>
  <div id="list"></div>
</main>
<footer>
  <span id="count" role="status"></span>
  <button class="linkbtn" onclick="doExport()">Export JSON</button>
  <button class="linkbtn" onclick="document.getElementById('imp').click()">Import JSON</button>
  <input id="imp" type="file" accept="application/json" aria-label="Import JSON file" style="display:none" onchange="doImport(this)">
  <button class="linkbtn" onclick="logout()">Change token</button>
</footer>
</div>

<div id="gate" class="gate">
  <h1 style="font-size:28px">mono<span style="color:var(--accent)">mem</span></h1>
  <p class="muted"><label for="tok">Paste your Monomem token to view the store.</label> It is in the <code>.token</code> file in your Monomem data folder; <code>monomem doctor</code> shows where that is.</p>
  <input id="tok" type="password" placeholder="MONOMEM_TOKEN" onkeydown="if(event.key==='Enter')saveTok()">
  <button onclick="saveTok()">Open</button>
  <p id="gate_err" class="err" role="alert"></p>
</div>
<script src="/dashboard.js"></script>
</body>
</html>`;

// Served at GET /dashboard.js. Kept as its own string (and out of the HTML
// above) so it can use normal quotes without clashing with this file's
// template literals. No backticks are used inside.
export const DASHBOARD_JS = `
var TOKKEY = "om_tok";
function tok(){ try { return sessionStorage.getItem(TOKKEY) || ""; } catch(e){ return ""; } }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]; }); }
function $(id){ return document.getElementById(id); }

// A small coloured chip per writer: a stable hash of the label picks the hue (the label itself is escaped text).
var HUES = [30,195,96,261,162,327,63,228,129,294], hueOf = {}; // ten hues in an order where neighbours are far apart, none red (red reads as danger next to delete)
function hue(s){ s = String(s); if(hueOf[s] !== undefined) return hueOf[s];
  var h = 0; for(var i = 0; i < s.length; i++){ h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  var used = {}; for(var k in hueOf) used[hueOf[k]] = 1;
  for(var j = 0; j < HUES.length; j++){ var c = HUES[(h + j) % HUES.length]; if(!used[c]){ return (hueOf[s] = c); } }
  return (hueOf[s] = HUES[h % HUES.length]); } // the stable hash picks a start; a hue another writer already has is skipped (past ten writers they repeat)
function shownWriter(w){ return w === "primary" ? "admin (setup)" : w; } // display only: the stored label stays "primary"
function chip(label){ return "<span class='chip' style='--h:"+hue(label)+"'>"+esc(shownWriter(label))+"</span>"; }
function acts(html){ return "<div class='acts'>"+html+"</div>"; }
function byLine(w){ return w ? " &middot; by "+chip(w) : ""; }

// Messages (errors, results) go to the status line, never a popup dialog; say() replaces whatever was there.
function say(text, isErr){ var m = $("msg"); m.className = "msg" + (isErr ? " err" : ""); m.textContent = text || ""; }
function fail(e){ say(e && e.message ? e.message : String(e), true); }
function failList(e){ $("list").innerHTML = "<p class='err'>"+esc(e.message)+"</p>"; }
function empty(text){ return "<p class='muted'>"+text+"</p>"; }

// Inline confirm: the first click turns the button into "Confirm <label>?" for a few seconds; a second click runs fn.
function arm(btn, fn){
  if(btn.getAttribute("data-armed")){ clearTimeout(btn._t); btn.removeAttribute("data-armed"); fn(); return; }
  var was = btn.textContent;
  btn.setAttribute("data-armed", "1");
  btn.textContent = "Confirm " + was.toLowerCase() + "?";
  var m = $("msg"); if(m){ m.className = "msg"; m.textContent = "Press " + was + " again within 4 seconds to confirm."; }
  var hint = m ? m.textContent : "";
  btn._t = setTimeout(function(){ btn.removeAttribute("data-armed"); btn.textContent = was; if(m && m.textContent === hint) m.textContent = ""; }, 4000);
}
// Longer confirm with a server-written warning (supersede preview): text plus Confirm / Cancel on the status line.
function ask(text, okLabel, fn){
  var m = $("msg"); m.className = "msg"; m.textContent = text + " ";
  var ok = document.createElement("button"); ok.textContent = okLabel;
  ok.onclick = function(){ m.textContent = ""; fn(); };
  var no = document.createElement("button"); no.textContent = "Cancel"; no.className = "ghost";
  no.onclick = function(){ m.textContent = ""; };
  m.appendChild(ok); m.appendChild(no); ok.focus();
}

var VIEW = "list";
// The view buttons are a tab bar: the active one carries aria-current.
var TABS = { list:"list", held:"held", review:"review", changes:"changes", sessions:"sessions", session:"sessions", quality:"quality", meter:"meter" };
function setView(v){
  VIEW = v;
  say("");
  ["list","held","review","changes","sessions","quality","meter"].forEach(function(t){
    $("tab_" + t).ariaCurrent = TABS[v] === t ? "page" : null;
  });
  showStrip();
}

function show(app){
  $("app").style.display = app ? "block" : "none";
  $("gate").style.display = app ? "none" : "block";
}
function saveTok(){
  var v = $("tok").value.trim();
  if(!v){ return; }
  try { sessionStorage.setItem(TOKKEY, v); } catch(e){}
  show(true); load();
}
function logout(){ try { sessionStorage.removeItem(TOKKEY); } catch(e){} show(false); }
function toggleNew(){
  var n = $("new");
  n.style.display = n.style.display === "block" ? "none" : "block";
}

function api(path, opts){
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers["Authorization"] = "Bearer " + tok();
  if(opts.body){ opts.headers["Content-Type"] = "application/json"; }
  return fetch(path, opts).then(function(r){
    if(r.status === 401){ logout(); throw new Error("unauthorized - check your token"); }
    return r.json().then(function(j){ if(!r.ok){ throw new Error(j.error || r.status); } return j; });
  });
}

function render(notes){
  var list = $("list");
  // Pinned notes first (stable sort), but a search keeps its relevance order.
  if(!$("q").value.trim()){ notes = notes.slice().sort(function(a, b){ return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); }); }
  $("count").textContent = notes.length + " note" + (notes.length===1?"":"s");
  if(!notes.length){
    list.innerHTML = $("q").value.trim() ? empty("No notes match that search. Try fewer words, or clear the namespace box.")
      : empty("No notes yet. Ask your assistant to remember something, or run <code>monomem setup</code>.");
    return;
  }
  list.innerHTML = notes.map(function(n){
    var tags = (n.tags||[]).map(function(t){ return "<span class='tag'>"+esc(t)+"</span>"; }).join("");
    return "<div class='card'><div class='cardhead'><div>"+
      "<h3>"+esc(n.title)+(n.pinned ? "<span class='badge-pin' title='Pinned: agents can read it; only the monomem CLI can change it'>Pinned</span>" : "")+
      (n.distrusted ? "<span class='badge-bad' title='An admin distrusts the writer of this note: treat its content as hostile'>DISTRUSTED</span>" : "")+"</h3>"+
      "<div class='meta'>#"+n.id+" &middot; "+esc(n.namespace)+" &middot; "+esc((n.updated_at||"").slice(0,16).replace("T"," "))+byLine(n.written_by)+"</div>"+
      tags+"</div>"+
      acts(((n.tags||[]).indexOf("never-show") >= 0
        ? "<button class='ghost' title='Let it be shown at session start again' onclick='neverShow("+n.id+",false)'>show again</button>"
        : "<button class='ghost' title='Never inject this note at session start (it stays searchable)' onclick='neverShow("+n.id+",true)'>never show</button>")+
      " <button class='danger' onclick='arm(this,function(){del("+n.id+")})'>delete</button>")+"</div>"+
      (n.body ? "<div class='body'>"+esc(n.body)+"</div>" : "")+"</div>";
  }).join("");
}

function inc(){ var c = $("inc"); return !!(c && c.checked); }

function loadRunner(){
  var el = $("runner");
  api("/runner/status").then(function(j){
    // One line per runner (each target has its own heartbeat); fall back to the single notice of older servers.
    var lines = [];
    ((j && j.targets) || []).forEach(function(t){ if(t.notice){ lines.push(t.notice); } });
    if(!lines.length && j && j.notice){ lines.push(j.notice); }
    el.textContent = "";
    if(lines.length){
      lines.forEach(function(l){ var d = document.createElement("div"); d.textContent = l; el.appendChild(d); });
      el.style.display = "block";
    } else { el.style.display = "none"; }
  }).catch(function(){ el.style.display = "none"; });
}

// "distrusted" needs an admin token: the server refuses it for any other (403); untick the box so the next load works.
function incRefused(e){
  if(inc() && /admin/i.test(String(e && e.message))){ $("inc").checked = false; }
}

function load(){
  setView("list");
  loadRunner();
  loadHeldCount();
  var q = $("q").value.trim();
  var ns = $("ns").value.trim();
  var qs = (ns ? ("namespace=" + encodeURIComponent(ns)) : "") + (inc() ? ((ns ? "&" : "") + "include_distrusted=1") : "");
  var path;
  if(q){ path = "/search?q=" + encodeURIComponent(q) + (qs?("&"+qs):""); }
  else { path = "/notes" + (qs?("?"+qs):""); }
  api(path).then(function(j){ render(j.results || j.notes || []); })
    .catch(function(e){ incRefused(e); failList(e); });
}

function loadChanges(){
  setView("changes");
  var ns = $("ns").value.trim();
  var path = "/changes?since=24h&limit=200" + (ns ? ("&namespace=" + encodeURIComponent(ns)) : "") + (inc() ? "&include_distrusted=1" : "");
  api(path).then(function(j){
    var c = j.counts || {};
    $("count").textContent = "last 24h: " + (c.created||0) + " created, " +
      (c.updated||0) + " updated, " + (c.deleted||0) + " deleted" + (j.quarantined ? (", " + j.quarantined + " quarantined") : "");
    var srcs = Object.keys(j.bySource || {}).map(function(k){
      var v = j.bySource[k];
      return "<span class='tag'>"+esc(k || "(no source)")+": +"+v.created+" ~"+v.updated+" -"+v.deleted+"</span>";
    }).join("");
    var rows = (j.changes || []).slice().reverse().map(function(e){
      var mark = e.kind === "created" ? "+" : (e.kind === "updated" ? "~" : "-");
      return "<div class='card'><h3>"+mark+" "+esc(e.title)+(e.distrusted ? "<span class='badge-bad'>DISTRUSTED</span>" : "")+"</h3><div class='meta'>"+esc(e.kind)+" &middot; #"+e.id+
        " &middot; "+esc(e.namespace)+" &middot; "+esc((e.at||"").slice(0,16).replace("T"," "))+
        byLine(e.written_by)+
        (e.source ? " &middot; claims "+esc(e.source) : "")+"</div></div>";
    }).join("");
    $("list").innerHTML = "<div class='row'>"+srcs+"</div>" +
      (rows || empty("Nothing changed in the last 24 hours. New and edited notes will show up here."));
  }).catch(function(e){ incRefused(e); failList(e); });
}

// ---- Review queue: notes an AI agent wrote that nobody has looked at yet ----
// "Accepted" is the tag "reviewed" (tags do not change who wrote a note). Notes you or the server wrote yourself (cli,
// server, import:claude) are not queued. A writer the admin distrusts stays hidden, as everywhere else.
var HUMAN_WRITERS = { "cli": 1, "server": 1, "import:claude": 1, "": 1 };
function reviewQueue(notes, writer){
  return (notes || []).filter(function(n){
    if(HUMAN_WRITERS[n.written_by || ""]){ return false; }
    if((n.tags || []).indexOf("reviewed") >= 0){ return false; }
    // "stdio" also covers each self-declared stdio:<app> (trust.ts stdioFamily).
    return !writer || n.written_by === writer || (writer === "stdio" && String(n.written_by || "").indexOf("stdio:") === 0);
  });
}
function loadReview(){
  setView("review");
  var ns = $("ns").value.trim();
  var sel = $("rv_writer");
  var writer = sel ? sel.value : "";
  // Page through every note (500 at a time, at most 40 pages), so nothing past the first page is missed.
  var collected = [];
  function page(offset){
    return api("/notes?limit=500&offset=" + offset + (ns ? ("&namespace=" + encodeURIComponent(ns)) : "")).then(function(r){
      var got = r.notes || [];
      collected = collected.concat(got);
      return (got.length === 500 && offset < 20000) ? page(offset + 500) : { notes: collected, truncated: got.length === 500 };
    });
  }
  page(0).then(function(j){
    var all = reviewQueue(j.notes || []);
    var writers = {};
    all.forEach(function(n){ writers[n.written_by] = (writers[n.written_by] || 0) + 1; });
    var opts = "<option value=''>all writers (" + all.length + ")</option>" + Object.keys(writers).sort().map(function(w){
      return "<option value='" + esc(w) + "'" + (w === writer ? " selected" : "") + ">" + esc(shownWriter(w)) + " (" + writers[w] + ")</option>"; }).join("");
    var shown = reviewQueue(j.notes || [], writer);
    $("count").textContent = shown.length + " to review";
    var rows = shown.map(function(n){
      var tags = (n.tags||[]).map(function(t){ return "<span class='tag'>"+esc(t)+"</span>"; }).join("");
      return "<div class='card'><div class='cardhead'><div><h3>"+esc(n.title)+(n.pinned ? "<span class='badge-pin'>Pinned</span>" : "")+"</h3><div class='meta'>#"+n.id+" &middot; "+esc(n.namespace)+
        " &middot; written by "+chip(n.written_by)+" &middot; "+esc((n.updated_at||"").slice(0,16).replace("T"," "))+"</div>"+tags+"</div>"+
        acts("<button onclick='acceptNote("+n.id+")'>Accept</button> <button class='danger' onclick='arm(this,function(){del("+n.id+")})'>delete</button>")+"</div>"+
        (n.body ? "<div class='body'>"+esc(n.body)+"</div>" : "")+"</div>";
    }).join("");
    $("list").innerHTML = "<div class='row'><select id='rv_writer' aria-label='Filter by writer' onchange='loadReview()'>"+opts+"</select>"+
      "<span class='muted'>Accept keeps a note and marks it reviewed. Delete removes it.</span></div>" +
      (j.truncated ? "<p class='muted'>Showing the newest 20,000 notes only.</p>" : "") +
      (rows || empty("Nothing waiting for review. Notes your assistants write will queue here until you accept them."));
  }).catch(failList);
}
function acceptNote(id){
  api("/notes/" + id).then(function(j){
    var n = j.note || j;
    var tags = (n.tags || []).filter(function(t){ return t !== "reviewed"; }).concat(["reviewed"]);
    return api("/notes/" + id, { method:"PUT", body: JSON.stringify({ tags: tags, if_rev: n.rev }) });
  }).then(loadReview).catch(fail);
}

// ---- Held: writes the linter or a namespace policy kept out of the store until an admin decides (admin token) ----
// Everything shown is stored text from an untrusted writer, so all of it goes through esc().
var HELDN = 0;
function setHeldCount(n){
  HELDN = n;
  $("held_n").innerHTML = n ? "<span class='pill'>" + Number(n) + "</span>" : "";
  $("tab_held").className = n ? "lit" : "";
  showStrip();
}
// One line above the Notes list when something is held, so it is not missed.
function showStrip(){
  var s = $("heldstrip");
  s.hidden = !(HELDN > 0 && VIEW === "list");
  s.textContent = HELDN + (HELDN === 1 ? " write" : " writes") + " held for review \\u2192";
}
function loadHeldCount(){
  api("/quarantine" + nsQs("?", true)).then(function(j){ setHeldCount((j.quarantine || []).length); })
    .catch(function(){ setHeldCount(0); });
}
function refreshHeld(){ if(VIEW === "quality"){ loadQuality(); } else { loadHeld(); } }
function loadHeld(){
  setView("held");
  api("/quarantine" + nsQs("?", true)).then(function(j){
    var held = j.quarantine || [];
    setHeldCount(held.length);
    $("count").textContent = held.length + " held";
    $("list").innerHTML = held.length ? held.map(function(q){
      var why = (q.reasons || []).map(function(r){ return "<span class='tag why'>"+esc(r.label)+(r.field ? " in "+esc(r.field) : "")+"</span>"; }).join("");
      var who = q.written_by ? byLine(q.written_by) : (q.source ? " &middot; claims "+esc(q.source) : "");
      return "<div class='card held'><div class='cardhead'><div><span class='stamp'>HELD &middot; NOT IN SHARED MEMORY</span><h3>"+esc(q.title || "(title unchanged)")+"</h3>"+
        "<div class='meta'>held #"+Number(q.id)+" &middot; "+(q.op === "update" ? "update of #"+Number(q.target_id) : "new note")+
        " &middot; "+esc(q.namespace)+" &middot; "+when(q.created_at)+who+"</div>"+(why || "<span class='tag why'>held by policy</span>")+"</div>"+
        acts("<button onclick='arm(this,function(){qQuarantine("+Number(q.id)+",&quot;reject&quot;)})'>Reject</button> "+
        "<button class='ghost' onclick='arm(this,function(){qQuarantine("+Number(q.id)+",&quot;approve&quot;)})'>Approve</button>")+"</div>"+
        (q.body ? "<div class='heldbody'>"+esc(q.body)+"</div>" : "")+"</div>";
    }).join("") : empty("Nothing is held. Writes that look like secrets or injected instructions wait here for your approval.");
  }).catch(failList);
}

// ---- Sessions: what the capture hooks recorded, one session at a time (GET /sessions, GET /sessions/:id) ----
// Everything shown is stored text (prompts, titles, folders, even the session id), so all of it goes through esc(); the
// session id reaches the click handler through a data attribute, never spliced into script.
function nsQs(sep, noDistrusted){
  var ns = $("ns").value.trim();
  var qs = (ns ? ("namespace=" + encodeURIComponent(ns)) : "") + (!noDistrusted && inc() ? ((ns ? "&" : "") + "include_distrusted=1") : "");
  return qs ? (sep + qs) : "";
}
function when(s){ return esc(String(s||"").slice(0,16).replace("T"," ")); }
function loadSessions(){
  setView("sessions");
  api("/sessions?limit=100" + nsQs("&")).then(function(j){
    var ss = j.sessions || [];
    $("count").textContent = ss.length + " session" + (ss.length===1?"":"s");
    $("list").innerHTML = ss.length ? ss.map(function(s){
      return "<div class='card'><div class='cardhead'><div><h3>"+esc(s.summary || "(no summary yet)")+"</h3>"+
        "<div class='meta'>"+when(s.started_at)+(s.ended_at ? " to "+when(s.ended_at) : " &middot; open")+" &middot; "+esc(s.namespace)+
        " &middot; "+esc(s.cwd)+" &middot; "+Number(s.prompt_count||0)+" prompts, "+Number(s.event_count||0)+" events</div></div>"+
        acts("<button class='ghost' data-sid='"+esc(s.id)+"' onclick='loadSession(this.getAttribute(&quot;data-sid&quot;))'>Timeline</button>")+"</div></div>";
    }).join("") : empty("No sessions recorded yet. Run <code>monomem setup --capture</code> to install the hooks.");
  }).catch(function(e){ incRefused(e); failList(e); });
}
// One session: the summary on top, then prompts and observations merged oldest first.
function loadSession(id){
  setView("session");
  api("/sessions/" + encodeURIComponent(id) + nsQs("?")).then(function(j){
    var items = (j.prompts || []).map(function(p){ return { at: p.at, html: "<span class='tag'>prompt</span>"+esc(p.text) }; })
      .concat((j.rows || []).filter(function(r){ return r.kind !== "summary"; }).map(function(r){
        return { at: r.date, html: "<span class='tag'>"+esc(r.type)+"</span>#"+Number(r.id)+" "+esc(r.title)+
          (r.distrusted ? "<span class='badge-bad'>DISTRUSTED</span>" : "")+
          ((r.files||[]).length ? "<div class='meta'>"+(r.files||[]).map(esc).join(", ")+"</div>" : "") };
      }));
    items.sort(function(a,b){ return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
    var s = j.session || {}, sum = j.summary;
    $("count").textContent = items.length + " timeline entr" + (items.length===1?"y":"ies");
    $("list").innerHTML = "<div class='row'><button class='linkbtn' onclick='loadSessions()'>&larr; all sessions</button>"+
      "<span class='muted'>"+esc(s.id)+" &middot; "+esc(s.cwd)+"</span></div>"+
      (sum ? "<div class='card'><h3>"+esc(sum.title)+"</h3><div class='meta'>summary #"+Number(sum.id)+" &middot; "+when(sum.updated_at)+"</div>"+
        "<div class='body'>"+esc(sum.body)+"</div></div>" : "")+
      (items.length ? items.map(function(it){ return "<div class='card'><div class='meta'>"+when(it.at)+"</div>"+it.html+"</div>"; }).join("")
        : empty("Nothing recorded in this session yet."));
  }).catch(function(e){ incRefused(e); failList(e); });
}

// ---- Quality: what is worth a look (GET /quality, admin). Every button goes through a path that asks first and can be
// undone: replace = supersede preview, then confirm (undo: supersede undo), archive (undo: restore), quarantine approve/reject.
function loadQuality(){
  setView("quality");
  api("/quality" + nsQs("?")).then(function(j){
    var c = j.counts || {};
    $("count").textContent = Object.keys(c).map(function(k){ return c[k] + " " + k; }).join(", ");
    var rows = (j.issues || []).map(function(i){
      var a = Number(i.ids[0]), b = Number(i.ids[1]), q = Number(i.quarantine_id), btn = "";
      if(i.type === "duplicate" || i.type === "stale_twin"){ btn = "<button onclick='qReplace("+a+","+b+")'>Replace #"+a+" with #"+b+"</button>"; }
      else if(i.type === "quarantined"){ btn = "<button onclick='arm(this,function(){qQuarantine("+q+",&quot;reject&quot;)})'>Reject</button> <button class='ghost' onclick='arm(this,function(){qQuarantine("+q+",&quot;approve&quot;)})'>Approve</button>"; }
      else { btn = "<button class='ghost' onclick='arm(this,function(){qArchive("+a+")})'>Archive</button>"; }
      return "<div class='card'><div class='cardhead'><div><h3><span class='tag'>"+esc(i.type)+"</span>"+esc(i.detail)+"</h3>"+
        "<div class='meta'>"+esc(i.namespace)+" &middot; "+esc(i.fix)+(i.alt ? " &middot; or "+esc(i.alt) : "")+"</div></div>"+acts(btn)+"</div></div>";
    }).join("");
    var cf = j.conflict_groups || [];
    CFG = cf; CFACT = {};
    var tot = Number(j.conflict_total) || cf.length;
    var head = j.conflict_capped ? "showing "+cf.length+" of at least "+tot : (cf.length < tot ? "showing "+cf.length+" of "+tot : String(cf.length));
    var crow = cf.length ? "<div class='card'><h3>Conflicts ("+head+")</h3><div class='meta'>Different writers, same key, different value. Flag only: nothing changes until you press a button and confirm. Exact = the notes carry the same fact key. Possible = guessed from the text.</div>"+cf.map(function(g, gi){ return cfRow(g, gi); }).join("")+"</div>" : "";
    $("list").innerHTML = crow + rows || empty("No quality issues found. Duplicates, stale notes and held writes will be listed here.");
  }).catch(failList);
}
// One disputed key: every value with the notes that state it, then the buttons. No value is the default.
var CFG = [], CFACT = {};
function cfNote(n){
  return "<div class='meta'>#"+Number(n.id)+" "+esc(n.title)+" &middot; "+esc(n.writer)+" ("+esc(n.kind)+") &middot; "+esc(String(n.at).slice(0,10))+(n.pinned ? " &middot; pinned" : "")+"</div>";
}
function cfRow(g, gi){
  gi = Number(gi) || 0;
  var btns = [], more = [], all = [], seen = {};
  g.values.forEach(function(v, vi){
    v.notes.forEach(function(n){ all.push(n); });
    // Keeping one value changes the other values' notes, and a pinned note can only be changed from the CLI.
    var blocked = g.values.some(function(o, oi){ return oi !== vi && o.notes.some(function(n){ return n.pinned; }); });
    if(!blocked){ btns.push("<button class='ghost' onclick='cfKeep("+gi+","+vi+")'>Keep "+esc(v.value)+"</button>"); }
  });
  all.forEach(function(n){
    if(!n.pinned){ more.push("<button class='ghost' onclick='var x=this;arm(x,function(){qPin("+Number(n.id)+")})'>Pin #"+Number(n.id)+"</button>"); }
    if(!seen[n.writer]){
      seen[n.writer] = 1;
      more.push("<button class='ghost' data-ns='"+esc(g.namespace)+"' data-w='"+esc(n.writer)+"' onclick='var x=this;arm(x,function(){qDistrust(x)})'>Distrust "+esc(n.writer)+"</button>");
    }
  });
  var pins = all.filter(function(n){ return n.pinned; }).map(function(n){ return "#"+Number(n.id); });
  return "<div class='cf'><h3><span class='tag'>"+esc(g.confidence)+"</span>"+esc(g.key)+"</h3>"+
    g.values.map(function(v){ return "<div class='cfval'><b>"+esc(v.value)+"</b>"+v.notes.map(cfNote).join("")+"</div>"; }).join("")+
    "<div class='meta'>Namespace: <b>"+esc(g.namespace)+"</b>"+(pins.length ? " &middot; "+pins.join(", ")+" pinned: change it from the CLI" : "")+"</div>"+acts(btns.join(" "))+
    (more.length ? "<details class='cfmore'><summary class='muted'>More</summary>"+acts(more.join(" "))+"</details>" : "")+
    "<div class='cfdlg' id='cfdlg"+gi+"'></div></div>";
}
// The confirmation sits inside the clicked card: short bullets, then the buttons. Bullets are built from escaped pieces.
function cfDialog(gi, bullets, actions){
  CFACT[gi] = actions.map(function(a){ return a[1]; });
  $("cfdlg"+gi).innerHTML = "<ul>"+bullets.map(function(b){ return "<li>"+b+"</li>"; }).join("")+"</ul><div class='acts'>"+
    actions.map(function(a, i){ return "<button"+(a[2] ? " class='ghost'" : "")+" onclick='cfAct("+gi+","+i+")'>"+esc(a[0])+"</button>"; }).join(" ")+
    " <button class='ghost' onclick='cfClose("+gi+")'>Cancel</button></div>";
}
function cfAct(gi, i){ var f = CFACT[gi] && CFACT[gi][i]; if(f){ f(); } }
function cfClose(gi){ var d = $("cfdlg"+gi); if(d){ d.innerHTML = ""; } CFACT[gi] = []; }
function cfNoteText(n){ return "#"+Number(n.id)+" &ldquo;"+esc(n.title)+"&rdquo; ("+esc(n.writer)+")"; }
function cfFacts(n){ var k = Number(n); return k === 1 ? "1 other fact" : k+" other facts"; }
function cfKeep(gi, vi){
  var g = CFG[gi]; if(!g){ return; }
  var keep = g.values[vi], losers = [];
  g.values.forEach(function(v, i){ if(i !== vi){ v.notes.forEach(function(n){ losers.push({ n: n, value: v.value }); }); } });
  if(g.tier !== "fact"){ cfReplace(gi, g, keep, losers); return; }
  var bullets = ["You are keeping <b>"+esc(g.key)+" = "+esc(keep.value)+"</b>."];
  losers.forEach(function(l){
    var o = Number(l.n.otherFacts) || 0;
    bullets.push(cfNoteText(l.n)+" says "+esc(g.key)+" = "+esc(l.value)+". That one fact is removed. The note stays"+(o ? ", with its "+cfFacts(o)+"." : "."));
  });
  bullets.push("The note's text may still mention the old value. The note gets a <b>fact-removed:"+esc(g.key)+"</b> tag so you can find it and edit the text.");
  bullets.push("No note is deleted or hidden. To bring a fact back, write it on the note again.");
  cfDialog(gi, bullets, [["Remove the disputed fact", function(){ cfRemoveFacts(gi, g, losers); }], ["Replace whole note instead", function(){ cfReplace(gi, g, keep, losers); }, 1]]);
}
// Removes only the disputed fact tag, through the ordinary note edit (lint, approve-first and the pin gate still apply).
function cfRemoveFacts(gi, g, losers){
  var p = Promise.resolve(), done = 0, held = 0;
  losers.forEach(function(l){
    var fk = l.n.factKey || g.key, pre = "fact:"+fk+"=", mark = "fact-removed:"+fk;
    p = p.then(function(){
      return api("/notes/"+Number(l.n.id)).then(function(j){
        var n = j.note || j;
        var tags = (n.tags || []).filter(function(t){ return String(t).trim().indexOf(pre) !== 0 && t !== mark; }).concat([mark]);
        return api("/notes/"+Number(l.n.id), { method:"PUT", body: JSON.stringify({ tags: tags, if_rev: n.rev }) });
      }).then(function(r){ if(r && r.quarantined){ held++; } else { done++; } });
    });
  });
  p.then(function(){
    loadQuality();
    var m = held ? (done ? "Removed "+g.key+" from "+done+(done === 1 ? " note" : " notes")+"; " : "")+held+(held === 1 ? " change is" : " changes are")+" held for review (approve-first), so nothing was removed there yet." : "Removed "+g.key+" from "+done+(done === 1 ? " note." : " notes.");
    say(m+(done ? " The note text may still mention the old value: search for the tag fact-removed:"+g.key+"." : ""));
  })
   .catch(function(e){ loadQuality(); say("Removed "+g.key+" from "+done+" of "+losers.length+" notes ("+held+" held for review), then: "+(e && e.message ? e.message : String(e)), true); });
}
// Replace whole note: the server's preview issues the one-time code; the bullets are ours.
function cfReplace(gi, g, keep, losers){
  api("/supersede/preview", { method:"POST", body: JSON.stringify({ old_ids: losers.map(function(l){ return Number(l.n.id); }), new_id: Number(keep.notes[0].id), gui: true }) }).then(function(p){
    var bullets = ["You are keeping <b>"+esc(g.key)+" = "+esc(keep.value)+"</b> (note #"+Number(keep.notes[0].id)+")."];
    losers.forEach(function(l){
      var o = Number(l.n.otherFacts) || 0;
      bullets.push("Replaces "+cfNoteText(l.n)+": it stops showing in search and lists"+(g.tier === "fact" && o ? ", and its "+cfFacts(o)+" go with it." : "."));
    });
    bullets.push("Nothing is deleted. To bring one back: monomem supersede undo "+Number(losers[0].n.id)+".");
    if(p.requires_acknowledgement){ bullets.push("An administrator warning applies to this replacement. Confirming accepts it."); }
    cfDialog(gi, bullets, [["Replace whole note", function(){
      var body = { token: p.token };
      if(p.requires_acknowledgement){ body.acknowledge_risk = true; }
      api("/supersede/confirm", { method:"POST", body: JSON.stringify(body) }).then(loadQuality).catch(fail);
    }]]);
  }).catch(fail);
}
function qReplace(oldId, newId){
  // gui: the server words the question for a person (no request codes or POST instructions).
  api("/supersede/preview", { method:"POST", body: JSON.stringify({ old_ids: [oldId], new_id: newId, gui: true }) }).then(function(p){
    ask(p.warning, "Confirm replace", function(){
      var body = { token: p.token };
      if(p.requires_acknowledgement){ body.acknowledge_risk = true; }
      api("/supersede/confirm", { method:"POST", body: JSON.stringify(body) }).then(loadQuality).catch(fail);
    });
  }).catch(fail);
}
function qPin(id){
  api("/pinned", { method:"PUT", body: JSON.stringify({ id: id, pinned: true }) }).then(loadQuality).catch(fail);
}
function qDistrust(btn){
  api("/trust/distrust", { method:"POST", body: JSON.stringify({ namespace: btn.getAttribute("data-ns"), writer: btn.getAttribute("data-w") }) }).then(loadQuality).catch(fail);
}
// The caller's button already asked ("Confirm archive?"); these just act.
function qArchive(id){
  api("/notes/" + id + "/archive", { method:"POST" }).then(loadQuality).catch(fail);
}
function qQuarantine(id, action){
  api("/quarantine/" + id + "/" + action, { method:"POST" }).then(function(){
    refreshHeld(); loadHeldCount(); say("Held write #" + id + (action === "approve" ? " stored." : " discarded."));
  }).catch(fail);
}

// "Never show again": the never-show tag keeps a note out of the session-start context (it stays searchable).
function neverShow(id, on){
  api("/notes/" + id).then(function(j){
    var n = j.note || j;
    var tags = (n.tags || []).filter(function(t){ return t !== "never-show"; }).concat(on ? ["never-show"] : []);
    return api("/notes/" + id, { method:"PUT", body: JSON.stringify({ tags: tags, if_rev: n.rev }) });
  }).then(load).catch(fail);
}

// ---- Meter: what Monomem costs you (GET /stats -> meter). Numbers only. ----
function loadMeter(){
  setView("meter");
  var ns = $("ns").value.trim();
  api("/stats" + (ns ? ("?namespace=" + encodeURIComponent(ns)) : "")).then(function(j){
    var m = j.meter || {}, t = m.totals || {};
    function num(v){ return Number(v||0).toLocaleString(); }
    $("count").textContent = num(t.sessions) + " metered session" + (t.sessions===1?"":"s");
    var rows = (m.recent || []).map(function(r){
      return "<tr><td>"+when(r.updated_at)+"</td><td>"+esc(r.namespace)+"</td><td>"+num(r.injected_tokens)+"</td><td>"+num(r.saved_tokens)+"</td><td>"+num(r.llm_tokens)+"</td></tr>";
    }).join("");
    $("list").innerHTML = "<div class='card'><h3>Totals</h3><div>"+
      "~"+num(t.injected_tokens)+" tokens injected at session start ("+num(t.injections)+" times)<br>"+
      "~"+num(t.saved_tokens)+" tokens of captured work they stood in for<br>"+
      num(t.llm_tokens)+" local-model tokens (0 = the optional summarizer is off)<br>"+
      num(m.capture_events)+" capture events recorded<br>"+
      "database "+(Number(m.db_bytes||0)/1048576).toFixed(1)+" MB on disk</div>"+
      "<div class='meta' style='margin-top:8px'>"+esc(m.note)+"</div></div>"+
      (rows ? "<div class='card'><h3>Recent sessions</h3><div class='scroll'><table style='width:100%;font-size:13px'><tr class='muted'><th scope='col' align='left'>updated</th><th scope='col' align='left'>namespace</th><th scope='col' align='left'>injected</th><th scope='col' align='left'>saved</th><th scope='col' align='left'>model</th></tr>"+rows+"</table></div></div>"
        : empty("No session metered yet: the numbers start with the next session the SessionStart hook runs for."));
  }).catch(failList);
}

function addNote(){
  var title = $("n_title").value.trim();
  var err = $("n_err"); err.textContent = "";
  if(!title){ err.textContent = "title is required"; return; }
  var tags = $("n_tags").value.split(",").map(function(t){return t.trim();}).filter(Boolean);
  var payload = { title: title, body: $("n_body").value,
    tags: tags, namespace: $("n_ns").value.trim() || undefined };
  api("/notes", { method:"POST", body: JSON.stringify(payload) })
    .then(function(j){
      $("n_title").value=""; $("n_body").value="";
      $("n_tags").value=""; toggleNew(); load();
      if(j && j.quarantined){ say("Held for admin review (held write #" + j.quarantined.id + "). See the Held tab."); } })
    .catch(function(e){ err.textContent = e.message; });
}

function del(id){
  api("/notes/" + id, { method:"DELETE" }).then(function(){ if(VIEW === "review"){ loadReview(); } else { load(); } }).catch(fail);
}

function doExport(){
  api("/export").then(function(j){
    var blob = new Blob([JSON.stringify(j, null, 2)], { type:"application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "monomem-export.json"; a.click();
  }).catch(fail);
}

function doImport(input){
  var f = input.files[0]; if(!f){ return; }
  var reader = new FileReader();
  reader.onload = function(){
    try {
      var data = JSON.parse(reader.result);
      var notes = data.notes || data;
      api("/import", { method:"POST", body: JSON.stringify({ notes: notes }) })
        .then(function(j){
          var a = j.attestations;
          load();
          say("Imported " + j.imported + " notes" + (a ? (" (" + a.verified + " with a verified writer attestation, " + a.unverified + " unverified)") : "")); })
        .catch(fail);
    } catch(e){ say("not valid JSON", true); }
  };
  reader.readAsText(f);
  input.value = "";
}

var t;
$("q").addEventListener("input", function(){ clearTimeout(t); t = setTimeout(load, 250); });
$("ns").addEventListener("input", function(){ clearTimeout(t); t = setTimeout(load, 250); });

if(tok()){ show(true); load(); } else { show(false); $("tok").focus(); }
`;

// The brand mark (docs/brand/mark-gold-48.png), served at GET /favicon.ico without a token.
export const FAVICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACMAAAAwCAYAAACbm8NsAAAEuklEQVR4nK2YeahnYxjHP+ec37VkZ6KYv4QphGyhRJYoSymKzFBKZIjJNslW1GTJ8geiyJKlDP/YSoMGfxhrRpOSRGPJJAaF6/r9jp7b95meOfds77n3qdN7znve87zf8+zPm21eu4JEKoBxeD4WOBU4HTgSeB1YBvwJZEDZl/EoAUQu5mPdXwgsB47W/AxwPfCg1icBSQEzAv7T/ZnAHcBh4f1LgIl4o0CQCqQvmJGALAIekESMJpKSgXioBjQLCSaTOoz5ycCTwGI92/w0cB7wmp6ZDxACkzog6M+vBtYIyIwM2MazBWRKUrKLhQYTdb5KqimD4WbyljUCYsAWhJrAlMBdwMqK6AsZ74tS8YIBqQMzkrivA24QkEJzNr4H3BpcvA9lQ8C4J5wG3KPNirBuWnHFn8sOAIWu5KDnXrM78ERg6BIwpo8CX3S4b77rCfdPgo0lUV4R5X3A3sFYSwH5Q9KiwWvyoM7B5Exs8+OAi8Qw13v/uxeA74NNEX7C52ztks1rV9w9HzCu05uDJ2Wac5t5SmNZ862pbD/gcWC98tNgMPZXR8hwXS1o3kBtANZVJBUldBPwKXCJ4s6yAZXAFqYoiLkR+5yr622BcMP10SLyM8CJ+gmLORcDzwPbyvuSwWwHnFXj6pnGDzSWAcjBwBsCNK3NVwrI1NAclUtF+2qzCKbQ+FVYa5ssAd6qAFktTyy0ZjxEVbmKIypxodT4N/Cz7k0NOwGvAHvqeRtgUwiGZfh2NATM4S1h+x9dTg8D+4cyIlMy3RSyt1OydIzhgS1gpmRTyNuWhoBoKvkOeEzvq3biNpYEZnELmB2A3XR/W5ifhPjzlzaty0GTFOkYmF1qwGQhzphdHKIuwN3dvWp1BdwcMMEReoFpEmWp8RTg0jDn8xuUONvAzFJf6XiBVIe+0LiqMufGu66hj6rSuG/bYkx/G9harE8onnqpKlc2TgGTa9yY8F0vN8+l+xQwmcYUifZy81wZNwWMU2ol1ykdA/NhpXToS9snru/cw8B8BnwdYksX+RrLT0nVvwFqk46B+Rd4tbJRG7k6LUelgokl7RzyF88mRMtM41FhgxTK2sDY9QnwZs/mLNd4DLBHSBt9qTFfeRkQI20XYwe8SJmcRONvdPM8NGnvqof2uT50+UBV1bp5XjHKaxXM8o4NvGE7HjhD96P5SsfBODML8dckuDk6rfAEOi/biW7mJw5Pq7zsOvJwdR6kM5xU25njvVWfd2ksV+Hd1XZ4+XAlcJnWTiVIaKsgWAUT25Vz1Bt5VdeUu9y+HlGvPhPOA7toq7CQNfh8EYqi54Dzg9TqNnGgtv5GwJt/l2xXEp7t25vQj0NjfwFwSwiQdcz97yYy6Jd1tDITPKdNUrNnOl0Lcm10J3AS8KUYZzWgXDVjqfhzhYodtTYW80Ul4G4RTxtNNBqDd9Tw3Q78GkCNdZUVFVuEvldFu50DHiB+s+2vSyOCarKZOoqF9z7AVTq9MHU4+XlwVhPcrDp4X07xEfAt8EPw1iwFDOHg0BlYg2eH0+fq5MvOBKvk53t1EfoXAbwC+Cm1OfeTKjdmSx3WVdq1l040TJWHSi0mwZ2DV/0O/KjLov03wMcCxf/CRWltnLlVZgAAAABJRU5ErkJggg==",
  "base64",
);
