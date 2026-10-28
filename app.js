"use strict";
// FrontDesk UI. Every string from /api/items comes from email and is untrusted: it reaches the
// DOM only through textContent / createTextNode. The single exception is item.url, used as an
// href only after a prefix check against Gmail's origin.

const SECTIONS = [
  { key: "needs_you", title: "Needs you", collapsed: false },
  { key: "fyi", title: "FYI", collapsed: false },
  { key: "ignore", title: "Ignore", collapsed: true },
  { key: "untriaged", title: "Not triaged yet", collapsed: false },
];
const GMAIL_PREFIX = "https://mail.google.com/";
// Static mode: the exported public demo (frontdesk export-demo). No server: the list and each
// message's HTML are files, and actions only change this tab's view. Timestamps are shifted by
// the time since export, so "10m ago" stays "10m ago" whenever someone opens it.
const STATIC = document.documentElement.dataset.static === "1";
const EXPORTED = Date.parse(document.documentElement.dataset.exported || "");
const staticHidden = new Set();
const staticLabels = new Map();   // item id -> bucket the visitor moved it to

function staticFile(itemId) {
  return itemId.replace(/[^A-Za-z0-9]/g, "-");
}

function shiftIso(iso, ms) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t + ms).toISOString();
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function parseSender(s) {
  // "Jane Doe <jane@example.com>" -> {name, addr}; "<a@b>" or "a@b" -> name falls back to addr.
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(s || "");
  if (m) return { name: m[1] || m[2], addr: m[2] };
  return { name: s || "Unknown sender", addr: "" };
}

function senderName(s) {
  return parseSender(s).name;
}

function gmailTime(iso) {
  // Gmail's header style: "10:02 AM (1 hour ago)", or "Oct 21, 10:02 AM" when older.
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  const clock = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (!sameDay) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " + clock;
  return clock + " (" + relTime(iso) + ")";
}

function messageFrame(itemId, index) {
  // The email's own HTML, served by /msg under a no-script, no-remote-load CSP. sandbox has no
  // allow-scripts, so nothing in the mail can run; allow-same-origin only lets this page read
  // the frame's height, and allow-popups lets links open in a new tab.
  const f = document.createElement("iframe");
  f.className = "mailframe";
  f.setAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
  f.setAttribute("referrerpolicy", "no-referrer");
  f.title = "Message";
  f.src = STATIC ? "msg/" + staticFile(itemId) + "-" + index + ".html"
    : "/msg?item=" + encodeURIComponent(itemId) + "&i=" + index;
  f.addEventListener("load", () => {
    const doc = f.contentDocument;
    if (doc && doc.documentElement) f.style.height = (doc.documentElement.scrollHeight + 4) + "px";
  });
  return f;
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.round(h / 24);
  if (d < 7) return d + "d ago";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function absTime(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleString();
}

function safeGmailUrl(u) {
  return typeof u === "string" && u.startsWith(GMAIL_PREFIX) ? u : null;
}

function buildDetail(item, triage) {
  const d = el("div", "detail");
  const msgs = Array.isArray(item.messages) ? item.messages : [];
  d.append(el("h2", "thread-subject", item.subject || "(no subject)"));
  // Summary first: the point of FrontDesk is not having to read the thread. The full thread is
  // one click away and built on first open (its iframes size themselves only when visible).
  const summary = triage && triage.summary ? triage.summary : "";
  if (summary) d.append(el("p", "summary", summary));
  const full = el("details", "fullthread");
  const people = new Set(msgs.map(m => parseSender(m.sender).name));
  full.append(el("summary", null, (summary ? "Show full thread" : "Thread") + " (" + msgs.length +
    (msgs.length === 1 ? " message" : " messages") + ", " + people.size +
    (people.size === 1 ? " person)" : " people)")));
  const thread = el("div", "thread");
  full.append(thread);
  let built = false;
  const buildThread = () => {
    if (built) return;
    built = true;
    msgs.forEach((m, i) => {
      const box = el("div", m.is_mine ? "msg mine" : "msg");
      const head = el("div", "msg-head");
      const who = parseSender(m.sender);
      const avatar = el("span", "avatar", (who.name.trim()[0] || "?").toUpperCase());
      const ident = el("div", "ident");
      const line = el("div", "who");
      line.append(el("span", "from", who.name));
      if (who.addr && who.addr !== who.name) line.append(el("span", "addr", "<" + who.addr + ">"));
      ident.append(line);
      head.append(avatar, ident, el("span", "at", gmailTime(m.sent_at)));
      box.append(head, m.has_html ? messageFrame(item.id, i) : el("p", "body", m.body || ""));
      thread.append(box);
    });
  };
  full.addEventListener("toggle", () => { if (full.open) buildThread(); });
  if (!summary) { full.open = true; buildThread(); }
  d.append(full);
  const reply = el("div", "reply");
  const actions = el("div", "actions");
  const proposed = triage && triage.proposed_reply ? triage.proposed_reply : "";
  const id = "reply-" + Math.random().toString(36).slice(2);
  const label = el("label", null, proposed ? "Proposed reply (edit it, then save)" : "Reply");
  label.htmlFor = id;
  const ta = el("textarea");
  ta.id = id;
  ta.value = proposed;
  ta.placeholder = "Write a reply";
  const hint = el("p", "hint");
  const save = el("button", "btn primary", "Save as Gmail draft");
  save.type = "button";
  const refresh = () => {
    // Placeholders like [time that works] mark facts only the owner knows; never save them.
    const open = ta.value.match(/\[[^\]\n]{1,80}\]/g) || [];
    save.disabled = !ta.value.trim() || open.length > 0;
    hint.textContent = open.length ? "Fill in " + open.join(", ") + " before saving." : "";
  };
  ta.addEventListener("input", refresh);
  refresh();
  save.addEventListener("click", () => saveDraft(item, ta, save));
  const copy = el("button", "btn", "Copy");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ta.value);
      copy.textContent = "Copied";
    } catch (e) {
      ta.select();
      copy.textContent = "Select and copy manually";
    }
    setTimeout(() => { copy.textContent = "Copy"; }, 1800);
  });
  reply.append(label, ta, hint);
  actions.append(save, copy);
  if (triage) {
    const moveTo = el("span", "moveto");
    moveTo.append(el("span", "kbdhint", "Move to"));
    for (const [b, name] of [["needs_you", "Needs you"], ["fyi", "FYI"], ["ignore", "Ignore"]]) {
      if (b === triage.bucket) continue;
      const mb = el("button", "btn small", name);
      mb.type = "button";
      mb.addEventListener("click", () => relabel(item, b, name, mb));
      moveTo.append(mb);
    }
    actions.append(moveTo);
  }
  const arch = el("button", "btn btn-archive", "Archive");
  arch.type = "button";
  arch.addEventListener("click", () => archive(item, arch));
  actions.append(arch);
  const url = safeGmailUrl(item.url);
  if (url) {
    const a = el("a", "btn", "Open in Gmail");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    actions.append(a);
  }
  if (actions.childNodes.length) reply.append(actions);
  if (triage) d.append(whyPanel(triage));
  d.append(reply);
  return d;
}

const cardItems = new WeakMap();   // li -> item, for keyboard actions

function buildCard(item, triage) {
  const li = el("li", "card");
  li.dataset.id = item.id;
  cardItems.set(li, item);
  const row = el("button", "row");
  row.type = "button";
  row.setAttribute("aria-expanded", "false");

  const urg = triage ? Math.max(1, Math.min(5, Number(triage.urgency) || 1)) : 0;
  const dot = el("span", urg ? "dot u" + urg : "dot none");
  dot.title = urg ? "Urgency " + urg + " of 5" : "Not triaged";

  const msgs = Array.isArray(item.messages) ? item.messages : [];
  const newest = msgs.length ? msgs[msgs.length - 1] : null;
  const meta = el("span", "meta");
  const line1 = el("span", "line1");
  line1.append(el("span", "sender", senderName(newest ? newest.sender : "")),
               el("span", "subject", item.subject || "(no subject)"));
  meta.append(line1);
  if (triage && triage.reason) meta.append(el("span", "reason", triage.reason));

  const when = el("span", "when", relTime(item.updated_at));
  when.title = absTime(item.updated_at);
  row.append(dot, meta, when);

  let detail = null;
  row.addEventListener("click", () => {
    const open = row.getAttribute("aria-expanded") === "true";
    if (open) {
      detail.hidden = true;
    } else {
      if (!detail) { detail = buildDetail(item, triage); li.append(detail); }
      detail.hidden = false;
    }
    row.setAttribute("aria-expanded", String(!open));
    li.classList.toggle("open", !open);
  });
  li.append(row);
  return li;
}

function clickKey() {
  // One key per click, so the server can tell a double-click from a deliberate second action.
  // getRandomValues works on plain-http pages, where crypto.randomUUID does not.
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

async function postAction(kind, itemId, extra) {
  if (STATIC) {
    if (kind === "archive") staticHidden.add(itemId);
    if (kind === "unarchive") staticHidden.delete(itemId);
    if (kind === "relabel") staticLabels.set(itemId, extra.bucket);
    if (kind === "profile") throw new Error("demo mode");
    if (kind === "draft") return { status: "done", demo: true, note: "Demo: nothing was saved to Gmail." };
    return { status: "done" };
  }
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "X-FrontDesk": "action", "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ kind, item_id: itemId, key: clickKey() }, extra || {})),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || "HTTP " + res.status);
  return out;
}

let toastTimer = null;
function toast(text, undoLabel, onUndo) {
  const t = document.getElementById("toast");
  t.replaceChildren(el("span", null, text));
  if (onUndo) {
    const u = el("button", "linkbtn", undoLabel);
    u.type = "button";
    u.addEventListener("click", () => { t.hidden = true; onUndo(); });
    t.append(u);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 10000);
}

async function saveDraft(item, ta, btn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Saving...";
  try {
    const out = await postAction("draft", item.id,
                                 { body: ta.value, seen_updated_at: item.updated_at });
    if (out.demo) {
      toast(out.note);
    } else {
      toast("Draft saved in Gmail.", "Open draft", () => {
        if (safeGmailUrl(out.url)) window.open(out.url, "_blank", "noopener");
      });
    }
    btn.textContent = "Saved";
  } catch (e) {
    btn.textContent = label;
    btn.disabled = false;
    toast("Save failed: " + e.message);
  }
}

async function relabel(item, bucket, name, btn) {
  btn.disabled = true;
  try {
    await postAction("relabel", item.id, { bucket });
    await load();
    toast("Moved to " + name + ". FrontDesk keeps your call as a private label.");
  } catch (e) {
    btn.disabled = false;
    toast("Move failed: " + e.message);
  }
}

async function archive(item, btn) {
  btn.disabled = true;
  try {
    await postAction("archive", item.id);
    await load();
    toast("Archived: " + (item.subject || "(no subject)"), "Undo", async () => {
      try {
        await postAction("unarchive", item.id);
        await load();
        toast("Moved back to the inbox.");
      } catch (e) {
        toast("Undo failed: " + e.message);
      }
    });
  } catch (e) {
    btn.disabled = false;
    toast("Archive failed: " + e.message);
  }
}

function whyPanel(t) {
  // Provenance for one ranking: enough to inspect it, price it and replay it on another model.
  const det = el("details", "why");
  det.append(el("summary", null, "Why this ranking"));
  const dl = el("dl");
  const band = t.urgency >= 5 ? "today" : t.urgency >= 3 ? "this week" : "whenever";
  const cost = t.cost_usd === null || t.cost_usd === undefined ? "n/a"
    : "$" + Number(t.cost_usd).toFixed(4);
  const rows = [
    ["Decision", t.bucket.replace("_", " ") + ", urgency " + t.urgency + " of 5 (" + band + ")"
      + (t.model_bucket ? "; you moved it here (the model said " + t.model_bucket.replace("_", " ") + ")" : "")],
    ["Reason", t.reason],
    ["Model", t.model_served || t.model],
    ["Prompt version", t.prompt_version || "unknown"],
    ["Tokens", t.tokens_in + " in (+" + t.cache_read + " cached), " + t.tokens_out + " out"],
    ["Latency", t.latency_ms + " ms"],
    ["Est. cost", cost],
    ["Ranked", absTime(t.triaged_at)],
  ];
  for (const [k, v] of rows) dl.append(el("dt", null, k), el("dd", null, v));
  det.append(dl);
  return det;
}

function expandAllButton(ul) {
  // Opens (or closes) every thread in one section by driving each row's own toggle, so expand
  // state and lazy detail-building stay in one code path.
  const b = el("button", "linkbtn", "Expand all");
  b.type = "button";
  b.addEventListener("click", () => {
    const rows = [...ul.querySelectorAll(":scope > li > .row")];
    const anyClosed = rows.some(r => r.getAttribute("aria-expanded") !== "true");
    for (const r of rows) {
      if ((r.getAttribute("aria-expanded") === "true") !== anyClosed) r.click();
    }
    b.textContent = anyClosed ? "Collapse all" : "Expand all";
  });
  return b;
}

function render(rows) {
  const main = document.getElementById("main");
  const counts = document.getElementById("counts");
  main.replaceChildren();
  counts.replaceChildren();

  const groups = Object.fromEntries(SECTIONS.map(s => [s.key, []]));
  for (const r of rows) {
    const key = r.triage && groups[r.triage.bucket] ? r.triage.bucket : "untriaged";
    groups[key].push(r);
  }

  if (!rows.length) {
    const p = el("p", "status", "Nothing synced yet. Run: ");
    p.append(el("code", null, "frontdesk sync"));
    main.append(p);
    return;
  }

  for (const s of SECTIONS) {
    const list = groups[s.key];
    if (s.key !== "untriaged" || list.length) {
      const c = el("li");
      c.append(el("b", null, String(list.length)), document.createTextNode(" " + s.title));
      counts.append(c);
    }
    if (!list.length) continue;
    const sec = el("section");
    sec.setAttribute("aria-label", s.title);
    const ul = el("ul", "list");
    for (const r of list) ul.append(buildCard(r.item, r.triage));
    const toggle = expandAllButton(ul);
    if (s.collapsed) {
      const det = el("details");
      const sum = el("summary", null, s.title + " (" + list.length + ")");
      det.append(sum, toggle, ul);
      sec.append(det);
    } else {
      const head = el("div", "sechead");
      head.append(el("h2", null, s.title), toggle);
      sec.append(head, ul);
    }
    main.append(sec);
  }
}

async function load() {
  const status = document.getElementById("status");
  try {
    const res = await fetch(STATIC ? "api/items.json" : "/api/items", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    let rows = await res.json();
    if (STATIC) {
      const delta = Number.isNaN(EXPORTED) ? 0 : Date.now() - EXPORTED;
      rows = rows.filter(r => !staticHidden.has(r.item.id)).map(r => {
        r.item.updated_at = shiftIso(r.item.updated_at, delta);
        for (const m of r.item.messages) m.sent_at = shiftIso(m.sent_at, delta);
        if (r.triage) r.triage.triaged_at = shiftIso(r.triage.triaged_at, delta);
        const moved = staticLabels.get(r.item.id);
        if (r.triage && moved && moved !== r.triage.bucket) {
          r.triage.model_bucket = r.triage.model_bucket || r.triage.bucket;
          r.triage.bucket = moved;
        }
        return r;
      });
    }
    render(rows);
    const again = visibleCards().find(li => li.dataset.id === currentId);
    if (again) again.classList.add("current");
  } catch (e) {
    status.textContent = "Could not load items: " + e.message;
  }
}

async function syncNow() {
  const btn = document.getElementById("sync");
  const note = document.getElementById("syncnote");
  if (STATIC) {
    note.textContent = "Demo: sync is off (synthetic inbox).";
    return;
  }
  btn.disabled = true;
  btn.textContent = "Syncing...";
  note.textContent = "";
  try {
    const res = await fetch("/api/sync", { method: "POST", headers: { "X-FrontDesk": "sync" } });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "HTTP " + res.status);
    let msg = "Synced " + out.synced + ", removed " + out.removed + ", ranked " + out.triaged;
    if (out.failed) msg += ", " + out.failed + " failed";
    if (out.triage_error) msg += ". Ranking skipped: " + out.triage_error;
    note.textContent = msg;
    await load();
  } catch (e) {
    note.textContent = "Sync failed: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Sync";
  }
}

// ---- Profile: a few sentences in the owner's words that the model treats as trusted context.
async function openProfile() {
  const panel = document.getElementById("profilepanel");
  const box = el("div", "helpbox");
  box.append(el("h2", null, "Your profile"));
  box.append(el("p", "kbdhint",
    "Tell FrontDesk what matters to you, in a few sentences. It is added to the model's " +
    "instructions as trusted context (your mail never is). Saving re-ranks on the next Sync."));
  const ta = el("textarea");
  ta.rows = 6;
  ta.maxLength = 2000;
  ta.placeholder = "For example: I'm job hunting, so recruiter mail is at least FYI. " +
    "Invoices from my landlord are always needs you.";
  const status = el("p", "kbdhint");
  const save = el("button", "btn primary", "Save");
  save.type = "button";
  const cancel = el("button", "btn", "Close");
  cancel.type = "button";
  cancel.addEventListener("click", () => { panel.hidden = true; });
  const row = el("div", "actions");
  row.append(save, cancel);
  box.append(ta, status, row);
  panel.replaceChildren(box);
  panel.hidden = false;
  try {
    const res = await fetch(STATIC ? "api/profile.json" : "/api/profile", { cache: "no-store" });
    const out = await res.json();
    ta.value = out.profile || "";
    if (out.demo) {
      save.disabled = true;
      ta.readOnly = true;
      status.textContent = "Demo: the profile is off here. In your own copy, edit it above.";
    }
  } catch (e) {
    status.textContent = "Could not load the profile: " + e.message;
  }
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await postAction("profile", "", { text: ta.value });
      status.textContent = "Saved. Click Sync to re-rank with it.";
    } catch (e) {
      status.textContent = "Save failed: " + e.message;
    } finally {
      save.disabled = false;
    }
  });
  ta.focus();
}

// ---- Keyboard shortcuts, after Gmail's: j/k move, o or Enter open, u close, e archive,
// r reply, ? help. Never while typing in a box, and never with Ctrl/Cmd/Alt held.
const SHORTCUTS = [
  ["j / k", "Next / previous thread"],
  ["o or Enter", "Open or close the thread"],
  ["u", "Close the thread"],
  ["e", "Archive"],
  ["r", "Reply (jump to the reply box)"],
  ["?", "Show or hide this list"],
  ["Esc", "Leave the reply box / close this list"],
];
let currentId = null;

function visibleCards() {
  return [...document.querySelectorAll("main .list > li.card")].filter(li => li.offsetParent !== null);
}

function setCurrent(li) {
  for (const c of document.querySelectorAll("li.card.current")) c.classList.remove("current");
  if (!li) { currentId = null; return; }
  li.classList.add("current");
  currentId = li.dataset.id;
  li.scrollIntoView({ block: "nearest" });
}

function currentCard() {
  const cards = visibleCards();
  return cards.find(li => li.dataset.id === currentId) || null;
}

function move(step) {
  const cards = visibleCards();
  if (!cards.length) return;
  const i = cards.findIndex(li => li.dataset.id === currentId);
  const next = i < 0 ? (step > 0 ? 0 : cards.length - 1)
    : Math.max(0, Math.min(cards.length - 1, i + step));
  setCurrent(cards[next]);
}

function isOpen(li) {
  return li.querySelector(":scope > .row").getAttribute("aria-expanded") === "true";
}

function toggleHelp(force) {
  const h = document.getElementById("help");
  h.hidden = force === undefined ? !h.hidden : !force;
}

function buildHelp() {
  const h = document.getElementById("help");
  const box = el("div", "helpbox");
  box.append(el("h2", null, "Keyboard shortcuts"));
  const dl = el("dl");
  for (const [k, v] of SHORTCUTS) dl.append(el("dt", null, k), el("dd", null, v));
  box.append(dl);
  h.replaceChildren(box);
  h.addEventListener("click", e => { if (e.target === h) toggleHelp(false); });
}

function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  const typing = t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" ||
                       t.tagName === "SELECT" || t.isContentEditable);
  if (e.key === "Escape") {
    if (typing) t.blur();
    toggleHelp(false);
    document.getElementById("profilepanel").hidden = true;
    return;
  }
  if (typing) return;
  const li = currentCard();
  switch (e.key) {
    case "j": move(1); break;
    case "k": move(-1); break;
    case "o":
      if (li) li.querySelector(":scope > .row").click();
      break;
    case "Enter":
      if (li && !(t && t.tagName === "BUTTON")) li.querySelector(":scope > .row").click();
      else return;   // a focused button handles Enter itself
      break;
    case "u":
      if (li && isOpen(li)) li.querySelector(":scope > .row").click();
      break;
    case "e":
      if (li && cardItems.get(li)) {
        const btn = li.querySelector(".actions .btn-archive") || el("button");
        move(1);
        archive(cardItems.get(li), btn);
      }
      break;
    case "r":
      if (li) {
        if (!isOpen(li)) li.querySelector(":scope > .row").click();
        const ta = li.querySelector("textarea");
        if (ta) { ta.focus(); ta.scrollIntoView({ block: "center" }); }
      }
      break;
    case "?": toggleHelp(); break;
    default: return;
  }
  e.preventDefault();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("sync").addEventListener("click", syncNow);
  document.getElementById("profile").addEventListener("click", openProfile);
  buildHelp();
  document.addEventListener("keydown", onKey);
  load();
});
