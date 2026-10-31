"use strict";
// FrontDesk UI. Every string from /api/items comes from email and is untrusted: it reaches the
// DOM only through textContent / createTextNode. The single exception is item.url, used as an
// href only after a prefix check against Gmail's origin.

const SECTIONS = [
  { key: "kept", title: "From search", collapsed: false },   // threads kept from a search
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
const staticHidden = new Map();   // item id -> "archived" | "done"
const staticLabels = new Map();   // item id -> bucket the visitor moved it to
const staticStars = new Map();    // item id -> starred, as the visitor left it

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

// Text boxes grow to fit their content: CSS field-sizing where the browser has it, else this.
const NATIVE_FIT = typeof CSS !== "undefined" && CSS.supports && CSS.supports("field-sizing", "content");
function fitText(t) {
  if (NATIVE_FIT || !t || t.tagName !== "TEXTAREA") return;
  t.style.height = "auto";
  t.style.height = (t.scrollHeight + 2) + "px";
}
document.addEventListener("input", e => fitText(e.target));
document.addEventListener("focusin", e => fitText(e.target));
document.addEventListener("toggle", e => {
  if (e.target && e.target.querySelectorAll) e.target.querySelectorAll("textarea").forEach(fitText);
}, true);

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

function safeOpenUrl(u) {
  // Gmail, or a Slack workspace host; anything else is not linked.
  if (safeGmailUrl(u)) return u;
  return typeof u === "string" && /^https:\/\/[a-z0-9-]+\.slack\.com\//.test(u) ? u : null;
}

// One message of a thread: sender, time, then its HTML in a sandboxed frame (stored threads
// only) or its plain text.
function messageBox(itemId, m, i) {
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
  box.append(head, m.has_html ? messageFrame(itemId, i) : el("p", "body", m.body || ""));
  return box;
}

function buildDetail(item, triage) {
  const d = el("div", "detail");
  const msgs = Array.isArray(item.messages) ? item.messages : [];
  // The thread's people first, right under the sender line they belong to, then the subject.
  // Fetched once per opened thread; Ask reads the same source.
  const people = peopleSource(item);
  d.append(peopleStrip(people, !!(triage && triage.bucket === "ignore")));
  people.load();
  d.append(el("h2", "thread-subject", item.subject || "(no subject)"));
  // Summary first: the point of FrontDesk is not having to read the thread. The full thread is
  // one click away and built on first open (its iframes size themselves only when visible).
  const summary = triage && triage.summary ? triage.summary : "";
  if (summary) d.append(el("p", "summary", summary));
  const full = el("details", "fullthread");
  const senders = new Set(msgs.map(m => parseSender(m.sender).name));
  full.append(el("summary", null, (summary ? "Show full thread" : "Thread") + " (" + msgs.length +
    (msgs.length === 1 ? " message" : " messages") + ", " + senders.size +
    (senders.size === 1 ? " person)" : " people)")));
  const thread = el("div", "thread");
  full.append(thread);
  let built = false;
  const buildThread = () => {
    if (built) return;
    built = true;
    msgs.forEach((m, i) => thread.append(messageBox(item.id, m, i)));
  };
  full.addEventListener("toggle", () => { if (full.open) buildThread(); });
  if (!summary) { full.open = true; buildThread(); }
  d.append(full);
  const reply = el("div", "reply");
  // The reply action row: a "reply" group (Save, Send, Copy) and a "thread" group pushed right
  // (Move to, Star, Archive or Done, then the Open in Gmail/Slack link, which leaves FrontDesk).
  const actions = el("div", "actions replyactions");
  const replyGroup = el("div", "replygroup");
  const threadGroup = el("div", "threadgroup");
  const proposed = triage && triage.proposed_reply ? triage.proposed_reply : "";
  const id = "reply-" + Math.random().toString(36).slice(2);
  const head = el("h3", "panelhead", "Reply");
  const label = el("label", null, proposed ? "Proposed by FrontDesk: edit it, then save or send" :
    "Write your reply");
  label.htmlFor = id;
  const ta = el("textarea");
  ta.id = id;
  ta.value = proposed;
  ta.placeholder = "Write a reply";
  const hint = el("p", "hint");
  const save = el("button", "btn primary", "Save as Gmail draft");
  save.type = "button";
  const send = el("button", "btn send", "Send...");
  send.type = "button";
  send.addEventListener("click", () => startSend(item, ta, send));
  const refresh = () => {
    // Placeholders like [time that works] mark facts only the owner knows; never save them.
    const open = ta.value.match(/\[[^\]\n]{1,80}\]/g) || [];
    save.disabled = !ta.value.trim() || open.length > 0;
    send.disabled = save.disabled;
    hint.textContent = open.length ? "Fill in " + open.join(", ") + " before saving." : "";
  };
  const edited = () => {
    // Editing after a save or a cancelled send means there is something new to save or send.
    save.textContent = "Save as Gmail draft";
    send.textContent = "Send...";
    refresh();
  };
  ta.addEventListener("input", edited);
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
  const draftNote = el("p", "hint draftnote");
  reply.append(head, label, ta, hint, draftNote);
  // Save draft, Send and Archive act through Gmail; a Slack thread gets Copy and Open in Slack.
  const isGmail = item.source !== "slack";
  if (isGmail && !STATIC) loadGmailDraft(item, { ta, label, save, proposed, draftNote, edited });
  if (isGmail) replyGroup.append(save);
  replyGroup.append(send, copy);
  if (triage) {
    // One native drop-down showing the current section (Gmail's "Move to"); v focuses it.
    const moveTo = el("label", "moveto");
    const pick = el("select", "movepick");
    pick.setAttribute("aria-label", "Move to");
    for (const [b, name] of BUCKET_NAMES) {
      pick.append(Object.assign(el("option", null, name), { value: b, selected: b === triage.bucket }));
    }
    pick.addEventListener("change", () => {
      const to = pick.value;
      relabel(item, to, bucketName(to), pick, triage.bucket);
    });
    pick.title = "Move to another section (v)";   // no visible label: the drop-down speaks for itself
    moveTo.append(pick);
    threadGroup.append(moveTo);
  }
  threadGroup.append(starButton(item, "btn"));
  const arch = el("button", "btn btn-archive", "Archive");
  arch.type = "button";
  arch.addEventListener("click", () => archive(item, arch));
  if (item.hidden) {
    // Only the Starred view lists a hidden thread: offer to bring it back instead.
    const back = el("button", "btn", item.hidden === "archived" ? "Move to inbox" : "Show in the list");
    back.type = "button";
    back.addEventListener("click", () => restore(item, back));
    threadGroup.append(back);
  } else if (isGmail) threadGroup.append(arch);
  else {
    const doneBtn = el("button", "btn btn-archive", "Done");
    doneBtn.type = "button";
    doneBtn.title = "Hide it here until someone posts again (nothing changes in Slack)";
    doneBtn.addEventListener("click", () => markDone(item, doneBtn));
    threadGroup.append(doneBtn);
  }
  const url = safeOpenUrl(item.url);
  // The demo always shows the link (its Slack threads have no real workspace URL).
  if (url || STATIC) {
    const where = item.source === "slack" ? "Slack" : "Gmail";
    const a = el("a", "openlink", "Open in " + where);
    if (STATIC) {
      // The demo's threads are synthetic, so the real link would land on an error page. Keep the
      // link looking and acting like one, and say what it does in the live app.
      const note = "Demo: in the live app this opens the thread in " + where + ".";
      a.href = "#";
      a.title = note;
      a.addEventListener("click", ev => { ev.preventDefault(); toast(note); });
    } else {
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    threadGroup.append(a);
  }
  for (const g of [replyGroup, threadGroup]) if (g.childNodes.length) actions.append(g);
  if (actions.childNodes.length) reply.append(actions);
  d.append(askPanel(item, ta, people));
  d.append(reply);
  // Provenance last: it is for inspecting a ranking, not for acting on the thread.
  if (triage) d.append(whyPanel(triage));
  return d;
}

const cardItems = new WeakMap();   // li -> item, for keyboard actions
// What the owner has open survives a re-render (after an action or an auto-sync refresh).
const openSections = new Set();
const openThreads = new Set();

function buildCard(item, triage) {
  const li = el("li", "card");
  li.dataset.id = item.id;
  if ((item.labels || []).includes("UNREAD")) li.classList.add("unread");
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
  if (item.hidden) when.prepend(el("span", "tag", item.hidden === "archived" ? "Archived" : "Done"));
  row.append(dot, meta, when);

  let detail = null;
  row.addEventListener("focus", () => { if (currentId !== item.id) setCurrent(li); });
  row.addEventListener("click", () => {
    if (li.dataset.swiped) { delete li.dataset.swiped; return; }   // the end of a swipe
    setCurrent(li);   // a clicked row is the current one, so j/k continue from it
    const open = row.getAttribute("aria-expanded") === "true";
    if (open) {
      detail.hidden = true;
    } else {
      if (!detail) { detail = buildDetail(item, triage); li.append(detail); }
      detail.hidden = false;
    }
    row.setAttribute("aria-expanded", String(!open));
    li.classList.toggle("open", !open);
    if (open) openThreads.delete(item.id); else openThreads.add(item.id);
    if (!open) markReadSoon(item, li, row);
  });
  li.append(row, starButton(item, "star"));
  if (!item.hidden) attachSwipe(li, row, item);
  if (openThreads.has(item.id)) {            // reopen after a re-render
    detail = buildDetail(item, triage);
    li.append(detail);
    row.setAttribute("aria-expanded", "true");
    li.classList.add("open");
  }
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
    if (kind === "archive") staticHidden.set(itemId, "archived");
    if (kind === "unarchive" || kind === "undone") staticHidden.delete(itemId);
    if (kind === "done") staticHidden.set(itemId, "done");
    if (kind === "star" || kind === "unstar") {   // this tab only: nothing reaches Gmail or Slack
      staticStars.set(itemId, kind === "star");
      return { status: "done", kind, starred: kind === "star", demo: true };
    }
    if (kind === "read") return { status: "done" };
    if (kind === "relabel") staticLabels.set(itemId, extra.bucket);
    if (kind === "profile" || kind === "note" || kind.startsWith("note_") ||
        kind.startsWith("person_") || kind.startsWith("situation_")) throw new Error("demo mode");
    if (kind === "send_prepare") {
      const it = (window.__items || []).find(r => r.item.id === itemId);
      if (it && it.item.source === "slack") {   // same label as sending._slack_target
        const s = it.item.subject || "";
        const to = itemId.endsWith(":dm") ? s.replace("Slack DM with ", "DM: ")
          : s.split(":")[0] + " (thread)";
        return { action_id: 1, to: [to], cc: [], demo: true, subject: s, body: extra.body };
      }
      const inbound = it ? it.item.messages.filter(m => !m.is_mine) : [];
      const to = inbound.length ? parseSender(inbound[inbound.length - 1].sender).addr : "";
      return { action_id: 1, to: to ? [to] : [], cc: [], demo: true,
               subject: "Re: " + (it ? it.item.subject : ""), body: extra.body };
    }
    if (kind === "send_confirm") return { status: "queued", demo: true, undo_seconds: 30 };
    if (kind === "send_cancel") return { status: "cancelled" };
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

// ---- Send: prepare (server derives recipients from the thread) -> the owner confirms exactly
// what will go out -> it leaves after the undo window unless cancelled.
async function startSend(item, ta, btn) {
  btn.disabled = true;
  let prep;
  try {
    prep = await postAction("send_prepare", item.id,
                            { body: ta.value, seen_updated_at: item.updated_at });
  } catch (e) {
    btn.disabled = false;
    toast("Can't send: " + e.message);
    return;
  }
  const panel = document.getElementById("profilepanel");
  panel.setAttribute("aria-label", "Confirm send");
  const box = el("div", "helpbox");
  box.append(el("h2", null, prep.demo ? "Send (demo: nothing will be sent)" : "Send this reply?"));
  const dl = el("dl", "sendmeta");
  dl.append(el("dt", null, "To"), el("dd", null, prep.to.join(", ") || "(nobody)"));
  if (prep.cc && prep.cc.length) dl.append(el("dt", null, "Cc"), el("dd", null, prep.cc.join(", ")));
  dl.append(el("dt", null, "Subject"), el("dd", null, prep.subject));
  box.append(dl, el("pre", "sendbody", prep.body));
  box.append(el("p", "kbdhint", "It leaves 30 seconds after you confirm; you can undo until then."));
  const go = el("button", "btn primary", "Send");
  go.type = "button";
  const back = el("button", "btn", "Cancel");
  back.type = "button";
  const row = el("div", "actions");
  row.append(go, back);
  box.append(row);
  panel.replaceChildren(box);
  panel.hidden = false;
  back.addEventListener("click", async () => {
    panel.hidden = true;
    btn.disabled = false;
    try { await postAction("send_cancel", item.id, { action_id: prep.action_id }); } catch (e) {}
  });
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      const c = await postAction("send_confirm", item.id, { action_id: prep.action_id });
      panel.hidden = true;
      sendCountdown(item, prep.action_id, c, btn);
    } catch (e) {
      go.disabled = false;
      toast("Send failed: " + e.message);
    }
  });
  go.focus();
}

function sendCountdown(item, actionId, c, btn) {
  let left = c.undo_seconds || 30;
  let undone = false;
  const tick = () => {
    if (undone) return;
    if (left <= 0) { finishSend(item, actionId, c, btn); return; }
    toast((c.demo ? "Demo: sending in " : "Sending in ") + left + "s", "Undo", async () => {
      undone = true;
      try {
        await postAction("send_cancel", item.id, { action_id: actionId });
        toast("Not sent. Your text is still in the box.");
        btn.disabled = false;
      } catch (e) {
        toast("Too late to undo: " + e.message);
      }
    });
    left -= 1;
    setTimeout(tick, 1000);
  };
  tick();
}

async function finishSend(item, actionId, c, btn) {
  if (c.demo) { toast("Demo: nothing was sent."); btn.textContent = "Sent (demo)"; return; }
  for (let i = 0; i < 30; i++) {
    const res = await fetch("/api/send-status?id=" + actionId, { cache: "no-store" });
    const s = res.ok ? await res.json() : { status: "unknown" };
    if (s.status === "sent") { toast("Sent."); btn.textContent = "Sent"; return; }
    if (["failed", "stale", "expired", "unknown", "cancelled"].includes(s.status)) {
      const why = { failed: "Gmail refused it", stale: "a new message arrived first",
                    expired: "it waited too long", unknown: "Gmail did not answer; check Sent",
                    cancelled: "it was cancelled" }[s.status];
      toast("Not confirmed sent: " + why + ".");
      btn.disabled = false;
      return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  toast("Still sending; check Gmail's Sent folder.");
}

// The thread's unsent Gmail draft, read from Gmail when the thread opens (FrontDesk keeps no
// copy, so an edit made in Gmail is what shows here). It replaces the proposal only if the box
// is untouched: nothing the owner has typed is ever overwritten.
async function loadGmailDraft(item, ui) {
  let out = null, error = "";
  try {
    const res = await fetch("/api/gmail-draft?item=" + encodeURIComponent(item.id), { cache: "no-store" });
    out = await res.json();
    if (!res.ok) error = (out && out.error) || ("HTTP " + res.status);
  } catch (e) { error = e.message; }
  if (error) {
    ui.draftNote.textContent = "Couldn't check Gmail for a saved draft: " + error;
    return;
  }
  const d = out && out.draft;
  if (!d || typeof d.body !== "string" || !d.body.trim() || ui.ta.value !== ui.proposed) return;
  ui.ta.value = d.body;
  ui.label.textContent = "Your Gmail draft: edit, then save or send";
  ui.edited();
  fitText(ui.ta);
  ui.save.textContent = "Saved";
  ui.save.disabled = true;
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

const BUCKET_NAMES = [["needs_you", "Needs you"], ["fyi", "FYI"], ["ignore", "Ignore"]];
function bucketName(b) { return (BUCKET_NAMES.find(([k]) => k === b) || [b, b])[1]; }

// Moves a thread to another section and records the owner's call. `from` enables Undo, which
// moves it back (a slip in a drop-down is likelier than a mis-click on a labelled button).
async function relabel(item, bucket, name, ctl, from) {
  ctl.disabled = true;
  try {
    await postAction("relabel", item.id, { bucket });
    await load();
    const undo = from && from !== bucket ? async () => {
      try { await postAction("relabel", item.id, { bucket: from }); await load(); toast("Moved back to " + bucketName(from) + "."); }
      catch (e) { toast("Undo failed: " + e.message); }
    } : null;
    toast("Moved to " + name + ". FrontDesk keeps your call as a private label.", undo ? "Undo" : null, undo);
  } catch (e) {
    ctl.disabled = false;
    if (from && ctl.tagName === "SELECT") ctl.value = from;
    toast("Move failed: " + e.message);
  }
}

// Opening a thread for ~2 seconds marks it read (Gmail, Slack DMs); skimming with j/k does not.
function markReadSoon(item, li, row) {
  if (!(item.labels || []).includes("UNREAD")) return;
  setTimeout(async () => {
    if (row.getAttribute("aria-expanded") !== "true") return;
    try {
      const out = await postAction("read", item.id);
      if (out.status === "done" || out.status === "already_read") {
        item.labels = item.labels.filter(l => l !== "UNREAD");
        li.classList.remove("unread");
      }
    } catch (e) { /* stays bold; the next open tries again */ }
  }, 2000);
}

async function markDone(item, btn) {
  btn.disabled = true;
  try {
    await postAction("done", item.id);
    await load();
    toast("Done: hidden until someone posts again.", "Undo", async () => {
      try {
        await postAction("undone", item.id);
        await load();
      } catch (e) {
        toast("Undo failed: " + e.message);
      }
    });
  } catch (e) {
    btn.disabled = false;
    toast("Done failed: " + e.message);
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

async function restore(item, btn) {
  btn.disabled = true;
  try {
    await postAction(item.hidden === "archived" ? "unarchive" : "undone", item.id);
    await load();
    toast(item.hidden === "archived" ? "Moved back to the inbox." : "Back in the list.");
  } catch (e) {
    btn.disabled = false;
    toast("Failed: " + e.message);
  }
}

// ---- Star: Gmail's own star (the STARRED label, so it shows in Gmail too); on Slack a flag in
// FrontDesk only, since Slack has no supported API for saving a message for later. A click
// shows the new state at once, marked pending, and keeps it only when the server confirms.
const STAR_SLACK_NOTE = "Starred in FrontDesk only: Slack has no supported API for saving a " +
  "message for later, so nothing changes in Slack";
const starButtons = new Map();   // item id -> its star buttons (row and detail)
let view = "all";                // "all" | "starred"
// Search: `query` filters the synced threads as you type; Enter also asks Gmail (all mail,
// archived too) through GET /api/search. gmailSearch holds that answer for one query:
// {q, loading} | {q, results, demo} | {q, error}. Results live in this tab only.
let query = "";
let gmailSearch = null;

function paintStar(b, on, pending, item) {
  b.textContent = b.classList.contains("star") ? (on ? "\u2605" : "\u2606") : (on ? "\u2605 Starred" : "\u2606 Star");
  b.setAttribute("aria-pressed", String(on));
  b.setAttribute("aria-label", on ? "Unstar" : "Star");
  b.disabled = pending;
  b.classList.toggle("on", on);
  b.classList.toggle("pending", pending);
  b.title = (pending ? "Saving... " : "") + (item.source === "slack" ? STAR_SLACK_NOTE
    : (on ? "Starred in Gmail. Click (or s) to unstar" : "Star in Gmail (s)"));
}

function starButton(item, cls) {
  const b = el("button", cls === "star" ? "star" : "btn btn-star");
  b.type = "button";
  paintStar(b, !!item.starred, false, item);
  b.addEventListener("click", () => toggleStar(item));
  if (!starButtons.has(item.id)) starButtons.set(item.id, new Set());
  starButtons.get(item.id).add(b);
  return b;
}

async function toggleStar(item) {
  const bs = starButtons.get(item.id) || new Set();
  if ([...bs].some(b => b.classList.contains("pending"))) return;   // one change at a time
  const want = !item.starred;
  bs.forEach(b => paintStar(b, want, true, item));
  try {
    await postAction(want ? "star" : "unstar", item.id);
    item.starred = want;
    bs.forEach(b => paintStar(b, want, false, item));
    await load();
  } catch (e) {
    bs.forEach(b => paintStar(b, !want, false, item));
    toast("Star failed: " + e.message);
  }
}

// ---- Swipe left to archive (Gmail) or mark done (Slack), on touch only. swipeDecide is pure
// so the rule is testable without touch: nothing happens until the finger has moved
// SWIPE_LOCK px; then the gesture locks to the axis it moved most along, and a vertical lock
// leaves the page to scroll. Only a left move counts, and it acts past the threshold.
const SWIPE_LOCK = 10;
function swipeThreshold(width) {
  return Math.max(72, Math.min(160, (width || 0) * 0.4));
}

function swipeDecide(dx, dy, lock, width) {
  if (!lock) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_LOCK) return { lock: null, offset: 0, act: false };
    lock = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
  }
  if (lock === "y") return { lock, offset: 0, act: false };
  const offset = Math.min(0, dx);
  return { lock, offset, act: -offset >= swipeThreshold(width) };
}

function attachSwipe(li, row, item) {
  let s = null;
  const reset = () => {
    li.classList.remove("swiping", "armed");
    li.style.removeProperty("--swipe");
  };
  row.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch") return;   // a mouse or pen never swipes
    s = { x: e.clientX, y: e.clientY, lock: null, act: false, id: e.pointerId,
          w: row.getBoundingClientRect ? row.getBoundingClientRect().width : 0 };
  });
  row.addEventListener("pointermove", e => {
    if (!s || e.pointerId !== s.id) return;
    const d = swipeDecide(e.clientX - s.x, e.clientY - s.y, s.lock, s.w);
    if (d.lock === "y") { s = null; reset(); return; }
    if (d.lock !== "x") return;
    if (!s.lock && row.setPointerCapture) row.setPointerCapture(e.pointerId);
    s.lock = "x";
    s.act = d.act;
    if (!li.querySelector(":scope > .swipe-reveal")) {
      li.prepend(el("span", "swipe-reveal", item.source === "slack" ? "Done" : "Archive"));
    }
    li.classList.add("swiping");
    li.classList.toggle("armed", d.act);
    li.style.setProperty("--swipe", d.offset + "px");
  });
  const end = cancelled => {
    if (!s) return;
    const g = s;
    s = null;
    if (g.lock === "x") {
      li.dataset.swiped = "1";                         // swallow the click this tap would make
      setTimeout(() => { delete li.dataset.swiped; }, 400);
    }
    if (g.lock === "x" && g.act && !cancelled) {
      li.style.setProperty("--swipe", "-100%");
      dismissCard(li).then(gone => { if (!gone) reset(); });
    } else {
      reset();                                         // a short swipe snaps back
    }
  };
  row.addEventListener("pointerup", () => end(false));
  row.addEventListener("pointercancel", () => end(true));
}

// Archive (Gmail) or Done (Slack) one card, from the e key or a swipe. Fades the row while the
// server works; moves the highlight only once it is gone, to the thread below it (or above, at
// the end). Resolves true when the card left the list.
function dismissCard(li) {
  const it = cardItems.get(li);
  if (!it || it.hidden) return Promise.resolve(false);
  const btn = li.querySelector(".actions .btn-archive") || el("button");
  const cards = visibleCards();
  const i = cards.indexOf(li);
  const nextId = (cards[i + 1] || cards[i - 1] || {}).dataset?.id || null;
  const wasCurrent = li.dataset.id === currentId;
  li.classList.add("leaving");
  const act = it.source === "slack" ? markDone(it, btn) : archive(it, btn);
  return act.then(() => {
    const still = visibleCards().find(c => c.dataset.id === it.id);
    if (still) { still.classList.remove("leaving"); return false; }   // the action failed
    if (wasCurrent) setCurrent(visibleCards().find(c => c.dataset.id === nextId) || null);
    return true;
  });
}

// ---- Memory authorship. "owner": typed or clicked by you here. "session:<name>": a tool or
// agent session wrote it on your behalf (frontdesk note / situation add). "unrecorded": written
// before FrontDesk recorded authors. Only "owner" counts as confirmed; Confirm or Save makes it so.
function fmtDate(iso) {
  const t = Date.parse(iso || "");
  return Number.isNaN(t) ? "an unknown date"
    : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function authorLabel(author, iso) {
  const d = fmtDate(iso);
  if (author === "owner") return "Written by you on " + d;
  if ((author || "").startsWith("session:")) {
    return "Written by session " + author.slice(8) + " on " + d + ", not confirmed";
  }
  return "Author not recorded, " + d + ", not confirmed";
}

function askerLabel(author) {
  if ((author || "").startsWith("session:")) {
    return "Asked by session " + author.slice(8) + " on your behalf, not typed by you";
  }
  return "Author not recorded";
}

// ---- The thread's people: one fetch per opened thread (the people half of GET /api/ask; the
// static demo exports it per thread), shared by the People strip and Ask, so the two never
// disagree. people: one address per person; notes: {address: {text, author, updated_at}};
// aliases: {address: [their other addresses]}; names: {address: the name you typed}; display:
// {key: how to show it} for keys that are not readable (a Slack user's display name), so a raw
// key never shows.
function peopleSource(item) {
  const subs = [];
  let first = null;
  const src = {
    data: null,
    async refresh() {
      const url = STATIC ? "api/people/" + staticFile(item.id) + ".json"
        : "/api/ask?item=" + encodeURIComponent(item.id);
      let data = null;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) data = await res.json();
      } catch (e) { data = null; }
      if (!data || typeof data !== "object" || Array.isArray(data)) return null;
      src.data = data;
      subs.forEach(f => f(data));
      return data;
    },
    load() {   // one fetch per opened thread; a failed one is retried by the next caller
      if (!first) first = src.refresh().then(d => { if (!d) first = null; return d; });
      return first;
    },
    subscribe(f) { subs.push(f); if (src.data) f(src.data); },
  };
  return src;
}

function personLabel(p, data) {
  // What the chip says: an email address as itself (with the name you typed, if any, before it),
  // a Slack key as its display name. Owen prefers the address visible to a name with the address
  // on hover, and it keeps a look-alike sender's domain in plain sight.
  const key = p.toLowerCase();
  const typed = (data.names || {})[key];
  const slack = (data.display || {})[key];
  if (slack) return typed || slack;
  return typed ? typed + " <" + p + ">" : p;
}

function noteEditor(p, data, refresh, draft) {
  // One person's note: who, their other addresses, the text, the author label, Save and (for a
  // note you did not write) Confirm. Saving from here records you as the author.
  const aliases = data.aliases || {};
  const names = data.names || {};
  const display = data.display || {};
  const notes = data.notes || {};
  const shown = a => display[a.toLowerCase()] || a;
  const box = el("div", "personeditor");
  const key = p.toLowerCase();
  box.append(el("p", "notewho", names[key] ? names[key] + " (" + shown(p) + ")" : shown(p)));
  const more = aliases[key] || [];
  if (more.length) box.append(el("p", "kbdhint authorlabel", "Also " + more.map(shown).join(", ")));
  const ok = Object.values(notes).every(n => n && typeof n === "object" && typeof n.text === "string");
  if (!ok) {   // never offer a Save that could write a placeholder over a real note
    box.append(el("p", "hint", "This page is out of date with the server. Reload FrontDesk to see " +
      "and edit your notes."));
    return box;
  }
  const n = notes[key];
  const t = el("textarea");
  t.rows = 2;
  t.value = draft.has(key) ? draft.get(key) : (n ? n.text : "");
  t.placeholder = "What should FrontDesk remember about " + shown(p) + "?";
  t.setAttribute("aria-label", "Note on " + personLabel(p, data));
  t.addEventListener("input", () => draft.set(key, t.value));
  const sv = el("button", "btn small", "Save");
  sv.type = "button";
  sv.addEventListener("click", async () => {
    if (!t.value.trim()) {   // saving empty text never deletes; Delete lives on the Memory page
      toast("A note needs text. To remove one, use Delete on the Memory page (key m).");
      return;
    }
    try {
      await postAction("note", "", { who: p, text: t.value, author: "owner" });
      draft.delete(key);
      toast("Note saved.");
      refresh();
    } catch (e) { toast("Save failed: " + e.message); }
  });
  box.append(t);
  if (n) box.append(el("p", "kbdhint authorlabel", authorLabel(n.author, n.updated_at)));
  const row = el("div", "actions");
  row.append(sv);
  if (n && n.author !== "owner") {
    const cf = el("button", "btn small", "Confirm");
    cf.type = "button";
    cf.title = "Mark this note as yours, as written";
    cf.addEventListener("click", async () => {
      try { await postAction("note_confirm", "", { who: p, author: "owner" }); refresh(); }
      catch (e) { toast("Confirm failed: " + e.message); }
    });
    row.append(cf);
  }
  box.append(row);
  return box;
}

const STRIP_MAX = 6;   // more people than this: show STRIP_MAX - 1 chips and "+N more"

function peopleStrip(src, ignored) {
  // Above the subject, under the sender line: a chip per person in the thread ("Name · note" or
  // "Name · add note"); a chip opens that person's note right under the strip, one at a time.
  // An Ignore thread starts as a single "People" link. The static demo is read-only.
  const wrap = el("div", "peoplestrip");
  wrap.hidden = true;
  const chips = el("div", "peoplechips");
  const editor = el("div", "personslot");
  wrap.append(chips, editor);
  const draft = new Map();   // unsaved text per person, kept when the editor closes
  let data = null;
  let openKey = null;
  let showAll = false;
  let expanded = !ignored;
  const chipEls = new Map();   // person key -> chip, for returning focus
  const render = () => {
    const people = (data && Array.isArray(data.people)) ? data.people : [];
    wrap.hidden = !people.length;
    chips.replaceChildren();
    editor.replaceChildren();
    chipEls.clear();
    if (!people.length) return;
    if (!expanded) {
      const link = el("button", "linkbtn peoplelink", "People");
      link.type = "button";
      link.setAttribute("aria-expanded", "false");
      link.addEventListener("click", () => { expanded = true; render(); });
      chips.append(link);
      return;
    }
    chips.append(el("span", "peoplelabel", "People"));   // reads as its own small section
    const readOnly = STATIC || data.demo === true;
    const notes = data.notes || {};
    const shown = showAll || people.length <= STRIP_MAX ? people : people.slice(0, STRIP_MAX - 1);
    for (const p of shown) {
      const key = p.toLowerCase();
      const has = !!notes[key];
      const chip = el("button", has ? "tag personchip hasnote" : "tag personchip",
        personLabel(p, data) + (has ? " · note" : " · add note"));
      chip.type = "button";
      chip.dataset.who = key;
      chip.setAttribute("aria-expanded", String(openKey === key));
      if (readOnly) {
        chip.disabled = true;
        chip.title = "Demo: notes on people need your own copy of FrontDesk";
      } else {
        chip.addEventListener("click", () => { openKey = openKey === key ? null : key; render(); });
      }
      chips.append(chip);
      chipEls.set(key, chip);
    }
    if (shown.length < people.length) {
      const more = el("button", "tag personchip more", "+" + (people.length - shown.length) + " more");
      more.type = "button";
      more.addEventListener("click", () => { showAll = true; render(); });
      chips.append(more);
    }
    const p = openKey && people.find(x => x.toLowerCase() === openKey);
    if (p && !readOnly) editor.append(noteEditor(p, data, () => src.refresh(), draft));
    else openKey = null;
  };
  // Escape (onKey) closes the open editor, focus returning to its chip.
  wrap.closeEditor = () => {
    if (!openKey) return false;
    const key = openKey;
    openKey = null;
    render();
    const chip = chipEls.get(key);
    if (chip) chip.focus();
    return true;
  };
  src.subscribe(d => { data = d; render(); });
  return wrap;
}

// ---- Ask: reason about this thread with the context (history with these people, your notes).
// Answers are model text from untrusted mail: shown as plain text; a draft only fills the box.
function askPanel(item, replyBox, people) {
  const det = el("details", "ask");
  const sum = el("summary", null, "Ask FrontDesk about this thread");
  det.append(sum);
  const body = el("div", "askbody");
  det.append(body);
  let loaded = false;
  det.addEventListener("toggle", () => {
    if (det.open && !loaded) { loaded = true; buildAsk(item, replyBox, body, sum, people); }
  });
  return det;
}

function renderAnswer(box, a, replyBox, refreshNotes, itemId) {
  const ans = el("div", "answer");
  ans.append(el("p", "answertext", a.text || a.answer || ""));
  const row = el("div", "actions");
  const draft = a.draft_reply || "";
  if (draft) {
    const use = el("button", "btn small", "Use as reply");
    use.type = "button";
    use.addEventListener("click", () => {
      replyBox.value = draft;
      replyBox.dispatchEvent(new Event("input"));
      replyBox.focus();
      toast("Draft is in the reply box: edit it, then Save or Send.");
    });
    row.append(use);
    ans.append(el("pre", "sendbody", draft));
  }
  for (const n of a.note_suggestions || []) {
    const who = n.label || n.who;   // label: a Slack user's display name for a key
    const b = el("button", "btn small", "Save note for " + who + ": " + n.text);
    b.type = "button";
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        // The server saves it only if n.who is someone in this thread (model output never
        // creates a person), appending to their note.
        await postAction("note_suggestion", itemId, { who: n.who, text: n.text, author: "owner" });
        b.textContent = "Saved note for " + who;
        refreshNotes();
      } catch (e) { b.disabled = false; toast("Save failed: " + e.message); }
    });
    row.append(b);
  }
  for (const t of a.situation_suggestions || []) {
    const b = el("button", "btn small", "Add to What's going on: " + t);
    b.type = "button";
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await postAction("situation_add", "", { text: t, author: "owner" });
        b.textContent = "Added to What's going on";
      } catch (e) { b.disabled = false; toast("Save failed: " + e.message); }
    });
    row.append(b);
  }
  if (row.childNodes.length) ans.append(row);
  if (a.model) {
    ans.append(el("p", "kbdhint", a.model + (a.cost_usd != null ? ", $" + Number(a.cost_usd).toFixed(3) : "")));
  }
  box.append(ans);
}

// Stored owner questions for the two built-in modes start with these words (assist.py).
const SECOND_PREFIX = "Give me a second opinion on your colleague's last answer";
const POLISH_PREFIX = "Review this draft reply against my goals";

function groupTurns(history) {
  // One turn = an owner question and the answers to it (an earlier Ask all gave several). A second opinion
  // joins the turn whose answer it reviews, so the two fold and show together.
  const turns = [];
  for (const h of history) {
    if (h.role === "owner") {
      if ((h.text || "").startsWith(SECOND_PREFIX) && turns.length) {
        turns[turns.length - 1].entries.push({ kind: "second", h });
      } else {
        turns.push({ entries: [{ kind: "q", h }] });
      }
    } else {
      if (!turns.length) turns.push({ entries: [] });
      turns[turns.length - 1].entries.push({ kind: "a", h });
    }
  }
  return turns;
}

function questionText(h) {
  const t = h.text || "";
  if (t.startsWith(POLISH_PREFIX)) return "Polish draft";
  return t;
}

async function buildAsk(item, replyBox, body, summaryEl, people) {
  if (STATIC) {
    body.append(el("p", "kbdhint", "Demo: Ask needs a live model. In your own copy it reads this " +
      "thread, your other threads with the same people and your notes, then advises."));
    return;
  }
  const history = el("div", "askhistory");
  const prev = el("details", "askprev");
  const prevSum = el("summary");
  prev.append(prevSum);
  const latest = el("div", "asklatest");
  history.append(prev, latest);
  const turnEls = [];
  const layout = () => {
    // Every turn but the last folds into "Earlier"; the latest stays open with its draft.
    turnEls.forEach((t, i) => (i < turnEls.length - 1 ? prev : latest).append(t));
    const n = turnEls.length - 1;
    prev.hidden = n < 1;
    prevSum.textContent = "Earlier: " + n + (n === 1 ? " question" : " questions");
    if (summaryEl) summaryEl.textContent = "Ask FrontDesk" + (turnEls.length ?
      " (" + turnEls.length + (turnEls.length === 1 ? " exchange)" : " exchanges)") : "");
  };
  const newTurn = () => { const t = el("div", "askturn"); turnEls.push(t); return t; };
  // The box starts with FrontDesk's own question (assist.ADVISE, from the server) as ordinary,
  // editable text: Ask sends whatever the box holds, and the box resets to it after an answer.
  const q = el("textarea");
  q.rows = 2;
  q.setAttribute("aria-label", "Your question about this thread");
  const askBtn = el("button", "btn primary", "Ask");
  askBtn.type = "button";
  // Before any exchange the box holds the starter question as editable text. After an answer it
  // empties for a follow-up (repeating the question read as if nothing had been sent), and this
  // link puts the starter question back.
  const starter = el("button", "linkbtn", "Use the starter question");
  starter.type = "button";
  starter.hidden = true;
  const second = el("button", "btn", "Second opinion");
  second.type = "button";
  second.title = "Have the review model check the last answer";
  const polish = el("button", "btn", "Polish draft");
  polish.type = "button";
  polish.title = "Review and tighten the draft in the reply box (or the last suggested draft)";
  const status = el("p", "kbdhint");
  const row = el("div", "actions");
  const pick = el("select", "modelpick");
  pick.title = "Model for Ask (Second opinion and Polish use the review model)";
  pick.append(Object.assign(el("option", null, "Default model"), { value: "" }));
  fetch("/api/models", { cache: "no-store" }).then(r => r.ok ? r.json() : []).then(ms => {
    for (const m of ms) pick.append(Object.assign(el("option", null, m.label), { value: String(m.index) }));
  }).catch(() => {});
  row.append(pick, askBtn, second, polish, starter);
  body.append(history, q, row, status);

  // Notes live in the People strip; a saved suggestion refreshes the shared source, so its chip
  // flips to "· note".
  const src = people || peopleSource(item);
  const refreshNotes = () => src.refresh();
  const data = await src.load();
  const advise = (data && typeof data.advise === "string") ? data.advise : "";
  const followUp = () => {
    q.value = "";
    q.placeholder = "Ask a follow-up";
    starter.hidden = !advise;
    fitText(q);
  };
  starter.addEventListener("click", () => { q.value = advise; q.focus(); fitText(q); });
  if ((data && data.history || []).length) followUp(); else { q.value = advise; fitText(q); }
  const askedBy = (box, h) => {
    if (h.author && h.author !== "owner") box.append(el("p", "kbdhint authorlabel", askerLabel(h.author)));
  };
  for (const turn of groupTurns((data && data.history) || [])) {
    const t = newTurn();
    for (const e of turn.entries) {
      if (e.kind === "q") { t.append(el("p", "askq", questionText(e.h))); askedBy(t, e.h); }
      else if (e.kind === "second") { t.append(el("p", "askq", "Second opinion on the answer above")); askedBy(t, e.h); }
      else renderAnswer(t, e.h, replyBox, refreshNotes, item.id);
    }
  }
  layout();
  let lastDraft = "";
  for (const h of (data && data.history) || []) if (h.draft_reply) lastDraft = h.draft_reply;
  const buttons = [askBtn, second, polish];
  const go = async (question, mode, draft) => {
    buttons.forEach(b => { b.disabled = true; });
    status.textContent = mode === "ask" ? "Thinking..." : "Asking the review model (slower)...";
    try {
      const chosen = mode === "ask" && pick.value !== "" ? Number(pick.value) : undefined;
      const out = await postAction("ask", item.id, { question, mode, draft: draft || "",
                                                     model: chosen, author: "owner" });
      // A second opinion joins the turn it reviews; anything else starts a new turn.
      const t = mode === "second" && turnEls.length ? turnEls[turnEls.length - 1] : newTurn();
      t.append(el("p", "askq", mode === "second" ? "Second opinion on the answer above" :
        mode === "polish" ? "Polish draft" : question));
      if (out.draft_reply) lastDraft = out.draft_reply;
      renderAnswer(t, out, replyBox, refreshNotes, item.id);
      layout();
      if (mode === "ask") followUp();
      status.textContent = "";
    } catch (e) {
      status.textContent = "Ask failed: " + e.message;
    } finally {
      buttons.forEach(b => { b.disabled = false; });
    }
  };
  askBtn.addEventListener("click", () => {
    if (!q.value.trim()) { status.textContent = "Type a question first."; return; }
    go(q.value, "ask");
  });
  second.addEventListener("click", () => go("", "second"));
  polish.addEventListener("click", () => {
    const d = replyBox.value.trim() || lastDraft;
    if (!d) { status.textContent = "Write or generate a draft first."; return; }
    go("", "polish", d);
  });
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

function starredToggle(n) {
  const c = el("li");
  const b = el("button", "linkbtn starview", view === "starred" ? "Show all threads" :
    "\u2605 " + n + " Starred");
  b.type = "button";
  b.setAttribute("aria-pressed", String(view === "starred"));
  b.addEventListener("click", () => { view = view === "starred" ? "all" : "starred"; render(window.__items || []); });
  c.append(b);
  return c;
}

function render(rows) {
  const main = document.getElementById("main");
  const counts = document.getElementById("counts");
  main.replaceChildren();
  counts.replaceChildren();
  starButtons.clear();
  if (query) { renderSearch(rows, main, counts); return; }
  const starred = rows.filter(r => r.item.starred);

  if (view === "starred") {
    // One list, in ranked order; archived or done Gmail threads stay while Gmail keeps the star.
    counts.append(starredToggle(starred.length));
    const sec = el("section");
    sec.setAttribute("aria-label", "Starred");
    const head = el("div", "sechead");
    head.append(el("h2", null, "Starred (" + starred.length + ")"));
    sec.append(head);
    if (!starred.length) sec.append(el("p", "status", "Nothing starred. Press s on a thread, or tap its star."));
    const ul = el("ul", "list");
    for (const r of starred) ul.append(buildCard(r.item, r.triage));
    sec.append(ul);
    main.append(sec);
    return;
  }
  rows = rows.filter(r => !r.item.hidden);

  const groups = Object.fromEntries(SECTIONS.map(s => [s.key, []]));
  for (const r of rows) {
    const key = r.item.kept ? "kept"
      : r.triage && groups[r.triage.bucket] ? r.triage.bucket : "untriaged";
    groups[key].push(r);
  }

  if (!rows.length) {
    const p = el("p", "status", starred.length ? "Inbox clear." : "Nothing synced yet. Run: ");
    if (!starred.length) p.append(el("code", null, "frontdesk sync"));
    main.append(p);
    if (starred.length) counts.append(starredToggle(starred.length));
    return;
  }

  for (const s of SECTIONS) {
    const list = groups[s.key];
    if ((s.key !== "untriaged" && s.key !== "kept") || list.length) {
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
      det.open = openSections.has(s.key);
      det.addEventListener("toggle", () => {
        if (det.open) openSections.add(s.key); else openSections.delete(s.key);
      });
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
  counts.append(starredToggle(starred.length));
}

// ---- Search ----
function matches(r, q) {
  const t = r.triage || {};
  const hay = [r.item.subject, t.summary, t.reason,
               ...(r.item.messages || []).flatMap(m => [m.sender, m.body])].join("\n").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

function buildResultCard(r) {
  // A thread Gmail's search found that FrontDesk has not synced: not ranked, not stored, so no
  // dot colour or reason. Opening it reads it in place; Keep brings it in.
  const li = el("li", "card result");
  li.dataset.id = r.id;
  if (r.unread) li.classList.add("unread");
  const row = el("button", "row");
  row.type = "button";
  const dot = el("span", "dot none");
  dot.title = "Not ranked: found by search";
  const meta = el("span", "meta");
  const line1 = el("span", "line1");
  line1.append(el("span", "sender", r.from_me ? "me" : senderName(r.sender || "")),
               el("span", "subject", r.subject || "(no subject)"));
  const n = Number(r.messages) || 1;
  meta.append(line1, el("span", "reason", (r.in_inbox ? "In the inbox" : "Archived") + ", " + n +
                                          (n === 1 ? " message" : " messages") + ". Not ranked."));
  const when = el("span", "when", relTime(r.updated_at));
  when.title = absTime(r.updated_at);
  row.append(dot, meta, when);
  row.setAttribute("aria-expanded", "false");
  let detail = null;
  row.addEventListener("focus", () => { if (currentId !== r.id) setCurrent(li); });
  row.addEventListener("click", () => {
    setCurrent(li);
    const open = row.getAttribute("aria-expanded") === "true";
    if (!detail) { detail = buildPreview(r); li.append(detail); }
    detail.hidden = open;
    row.setAttribute("aria-expanded", String(!open));
    li.classList.toggle("open", !open);
  });
  li.append(row);
  return li;
}

// A search result opened in place: the whole thread, fetched from Gmail when first opened and
// shown as plain text (nothing stored, no model), with Keep in FrontDesk and Open in Gmail.
function buildPreview(r) {
  const d = el("div", "detail");
  const status = el("p", "status", "Loading the thread from Gmail\u2026");
  const thread = el("div", "thread");
  const actions = el("div", "actions replyactions");
  const keep = el("button", "btn primary", "Keep in FrontDesk");
  keep.type = "button";
  keep.title = "Store it here, ranked, with Ask, reply and every action (one model call)";
  keep.addEventListener("click", () => keepResult(r, keep));
  actions.append(keep);
  const u = safeOpenUrl(r.url);
  if (u) {
    const a = el("a", "openlink", "Open in Gmail");
    a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer";
    actions.append(a);
  }
  d.append(status, thread, el("p", "kbdhint",
    "Not kept: this thread is read from Gmail and not stored. Keep it to rank it, ask about it " +
    "and reply."), actions);
  (async () => {
    try {
      const res = await fetch("/api/search/thread?id=" + encodeURIComponent(r.id), { cache: "no-store" });
      const out = await res.json();
      if (!res.ok) throw new Error((out && out.error) || "HTTP " + res.status);
      const msgs = (out.item && Array.isArray(out.item.messages)) ? out.item.messages : [];
      msgs.forEach((m, i) => thread.append(messageBox(r.id, { ...m, has_html: false }, i)));
      status.remove();
    } catch (e) {
      status.textContent = "Couldn't load the thread: " + e.message;
    }
  })();
  return d;
}

async function keepResult(r, btn) {
  btn.disabled = true;
  btn.textContent = "Keeping\u2026";
  try {
    const out = await postAction("keep", r.id);
    openThreads.add(r.id);
    clearSearch();
    await load();
    const li = visibleCards().find(c => c.dataset.id === r.id);
    if (li) setCurrent(li);
    toast(out.ranked ? "Kept and ranked. It's under From search until you archive it or mark it done."
                     : "Kept, but ranking failed; it's under From search, unranked.");
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Keep in FrontDesk";
    toast("Keep failed: " + e.message);
  }
}

function renderSearch(rows, main, counts) {
  const local = rows.filter(r => (!r.item.hidden || r.item.starred) && matches(r, query));
  const c = el("li");
  c.append(el("b", null, String(local.length)), document.createTextNode(" in FrontDesk"));
  counts.append(c);
  const sec = el("section", "searchres");
  sec.setAttribute("aria-label", "Search results");
  const head = el("div", "sechead");
  const clear = el("button", "linkbtn", "Clear search (Esc)");
  clear.type = "button";
  clear.addEventListener("click", clearSearch);
  head.append(el("h2", null, "Search: " + query), clear);
  sec.append(head, el("h3", null, "In FrontDesk (" + local.length + ")"));
  if (local.length) {
    const ul = el("ul", "list");
    for (const r of local) ul.append(buildCard(r.item, r.triage));
    sec.append(ul);
  } else {
    sec.append(el("p", "status", "No synced thread matches."));
  }
  const g = gmailSearch && gmailSearch.q === query ? gmailSearch : null;
  const known = new Set(rows.map(r => r.item.id));
  const found = g && g.results ? g.results.filter(r => !known.has(r.id)) : [];
  sec.append(el("h3", null, "All of Gmail" + (g && g.results ? " (" + found.length + ")" : "")));
  let note = null;
  if (STATIC) note = "Searching all of Gmail runs against your own account in the live app.";
  else if (!g) note = "Press Enter to search all of Gmail, archived mail included.";
  else if (g.loading) note = "Searching Gmail\u2026";
  else if (g.error) note = "Couldn't search Gmail: " + g.error;
  else if (g.demo) note = "Searching all of Gmail is off in demo mode.";
  else if (!found.length) note = "No other matches in Gmail.";
  if (note) sec.append(el("p", "status", note));
  if (found.length) {
    const ul = el("ul", "list");
    for (const r of found) ul.append(buildResultCard(r));
    sec.append(ul);
    if (g.results.length >= 20) {
      sec.append(el("p", "kbdhint", "The 20 newest matches. Narrow it with Gmail's operators, " +
                                    "such as from:, before: or has:attachment."));
    }
  }
  main.append(sec);
}

async function searchGmail(q) {
  if (STATIC || !q) { render(window.__items || []); return; }
  gmailSearch = { q, loading: true };
  render(window.__items || []);
  let next;
  try {
    const res = await fetch("/api/search?q=" + encodeURIComponent(q), { cache: "no-store" });
    const out = await res.json();
    if (!res.ok) throw new Error((out && out.error) || "HTTP " + res.status);
    next = { q, results: Array.isArray(out.results) ? out.results : [], demo: !!out.demo };
  } catch (e) {
    next = { q, error: e.message };
  }
  if (!gmailSearch || gmailSearch.q !== q) return;   // a newer search replaced this one
  gmailSearch = next;
  if (query === q) render(window.__items || []);
}

function clearSearch() {
  const box = document.getElementById("search");
  if (box) { box.value = ""; box.blur(); }
  if (!query && !gmailSearch) return;
  query = "";
  gmailSearch = null;
  render(window.__items || []);
}

function setupSearch() {
  const box = document.getElementById("search");
  if (!box) return;
  box.addEventListener("input", () => { query = box.value.trim(); render(window.__items || []); });
  box.addEventListener("keydown", e => {
    // Enter searches Gmail and leaves the box, as Gmail does, so j/k move through the results.
    if (e.key === "Enter") { e.preventDefault(); box.blur(); searchGmail(query); }
  });
}

async function load() {
  const status = document.getElementById("status");
  try {
    const res = await fetch(STATIC ? "api/items.json" : "/api/items", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    let rows = await res.json();
    if (STATIC) {
      const delta = Number.isNaN(EXPORTED) ? 0 : Date.now() - EXPORTED;
      rows = rows.map(r => {
        r.item.hidden = staticHidden.get(r.item.id) || r.item.hidden || "";
        if (staticStars.has(r.item.id)) r.item.starred = staticStars.get(r.item.id);
        r.item.updated_at = shiftIso(r.item.updated_at, delta);
        for (const m of r.item.messages) m.sent_at = shiftIso(m.sent_at, delta);
        if (r.triage) r.triage.triaged_at = shiftIso(r.triage.triaged_at, delta);
        const moved = staticLabels.get(r.item.id);
        if (r.triage && moved && moved !== r.triage.bucket) {
          r.triage.model_bucket = r.triage.model_bucket || r.triage.bucket;
          r.triage.bucket = moved;
        }
        return r;
      }).filter(r => !r.item.hidden || r.item.starred);   // same rule as the server's list
    }
    window.__items = rows;
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
  panel.setAttribute("aria-label", "Your profile");
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
  const signLabel = el("label", "kbdhint", "Sign-off for email replies (added to every " +
    "suggested email reply, not Slack)");
  const sign = el("textarea");
  sign.maxLength = 200;
  sign.placeholder = "For example: Best,\nAlex";
  signLabel.htmlFor = sign.id = "signoff-box";
  const status = el("p", "kbdhint");
  const save = el("button", "btn primary", "Save");
  save.type = "button";
  const cancel = el("button", "btn", "Close");
  cancel.type = "button";
  cancel.addEventListener("click", () => { panel.hidden = true; });
  const row = el("div", "actions");
  row.append(save, cancel);
  const sitBox = el("div", "situation");
  box.append(ta, signLabel, sign, status, row, sitBox);
  panel.replaceChildren(box);
  panel.hidden = false;
  const load = async () => {
    const res = await fetch(STATIC ? "api/profile.json" : "/api/profile", { cache: "no-store" });
    return res.json();
  };
  const reloadSituation = async () => {
    try {
      const out = await load();
      renderSituation(sitBox, out.situation || [], out.demo, reloadSituation);
    } catch (e) { toast("Could not load What's going on: " + e.message); }
  };
  try {
    const out = await load();
    ta.value = out.profile || "";
    sign.value = out.signoff || "";
    if (out.demo) {
      save.disabled = true;
      ta.readOnly = true;
      sign.readOnly = true;
      status.textContent = "Demo: the profile is off here. In your own copy, edit it above.";
    }
    renderSituation(sitBox, out.situation || [], out.demo, reloadSituation);
  } catch (e) {
    status.textContent = "Could not load the profile: " + e.message;
  }
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await postAction("profile", "", { text: ta.value, signoff: sign.value });
      status.textContent = "Saved. Click Sync to re-rank with it.";
    } catch (e) {
      status.textContent = "Save failed: " + e.message;
    } finally {
      save.disabled = false;
    }
  });
  ta.focus();
}

// ---- What's going on: what is live for you right now, sent to Ask with each question.
// items: [{id, text, author, created_at, updated_at}]. Anything you add, edit or confirm here
// is recorded as written by you.
function renderSituation(box, items, demo, reload) {
  box.replaceChildren(el("h3", null, "What's going on"));
  box.append(el("p", "kbdhint", "Decisions, open matters and anything else live for you now. " +
    "Ask reads these with every question; lines you did not write are marked unconfirmed."));
  const act = async (kind, extra, failMsg) => {
    try { await postAction(kind, "", Object.assign({ author: "owner" }, extra)); reload(); }
    catch (e) { toast(failMsg + ": " + e.message); }
  };
  if (!items.length) box.append(el("p", "kbdhint", "Nothing yet."));
  for (const it of items) {
    const li = el("div", "situationitem");
    const text = el("p", "situationtext", it.text);
    const label = el("p", "kbdhint authorlabel", authorLabel(it.author, it.updated_at));
    const row = el("div", "actions");
    if (!demo) {
      const edit = el("button", "btn small", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => {
        const ta = el("textarea");
        ta.rows = 2;
        ta.maxLength = 500;
        ta.value = it.text;
        const sv = el("button", "btn small primary", "Save");
        sv.type = "button";
        sv.addEventListener("click", () =>
          act("situation_update", { id: it.id, text: ta.value }, "Save failed"));
        const cancel = el("button", "btn small", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", reload);
        const r2 = el("div", "actions");
        r2.append(sv, cancel);
        li.replaceChildren(ta, r2);
        ta.focus();
      });
      row.append(edit);
      if (it.author !== "owner") {
        const ok = el("button", "btn small", "Confirm");
        ok.type = "button";
        ok.title = "Mark this as yours, as written";
        ok.addEventListener("click", () => act("situation_confirm", { id: it.id }, "Confirm failed"));
        row.append(ok);
      }
      const del = el("button", "btn small", "Delete");
      del.type = "button";
      del.addEventListener("click", () => act("situation_delete", { id: it.id }, "Delete failed"));
      row.append(del);
    }
    li.append(text, label, row);
    box.append(li);
  }
  if (demo) {
    box.append(el("p", "kbdhint", "Demo: this is off here. In your own copy, add items above."));
    return;
  }
  const add = el("textarea");
  add.rows = 2;
  add.maxLength = 500;
  add.placeholder = "For example: Decided to turn down the Acme offer; waiting on Bo's contract.";
  const addBtn = el("button", "btn small", "Add");
  addBtn.type = "button";
  addBtn.addEventListener("click", () => {
    if (add.value.trim()) act("situation_add", { text: add.value }, "Add failed");
  });
  const r3 = el("div", "actions");
  r3.append(addBtn);
  box.append(add, r3);
}

// ---- Memory: everything FrontDesk remembers for Ask, in one place. Profile, What's going on,
// then people, newest first. Delete, Merge and Confirm are yours alone (the server checks too).
// A display name seen in mail is shown greyed as unconfirmed and never reaches the model: a
// person has a name only once you type one.
async function openMemory() {
  const panel = document.getElementById("profilepanel");
  panel.setAttribute("aria-label", "Memory");
  const box = el("div", "helpbox memorybox");
  box.append(el("h2", null, "Memory"), el("p", "kbdhint", "Loading"));
  panel.replaceChildren(box);
  panel.hidden = false;
  const reload = async () => {
    try {
      const res = await fetch(STATIC ? "api/memory.json" : "/api/memory", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      renderMemory(box, await res.json(), reload);
    } catch (e) {
      box.replaceChildren(el("h2", null, "Memory"),
                          el("p", "kbdhint", "Could not load your memory: " + e.message));
    }
  };
  await reload();
}

function renderMemory(box, data, reload) {
  const demo = !!data.demo;
  const head = el("div", "memhead");
  const close = el("button", "btn small", "Close");
  close.type = "button";
  close.addEventListener("click", () => { document.getElementById("profilepanel").hidden = true; });
  head.append(el("h2", null, "Memory"), close);
  box.replaceChildren(head, el("p", "kbdhint", "Everything FrontDesk remembers for Ask, kept on " +
    "this computer. Ask sends the parts about a thread's people with each question."));
  if (!demo) {
    const dl = el("a", "btn small", "Download my memory (JSON)");
    dl.href = "/api/memory/export";
    dl.setAttribute("download", "frontdesk-memory.json");
    const r = el("div", "actions");
    r.append(dl);
    box.append(r);
  }
  const prof = el("div", "memsection");
  prof.append(el("h3", null, "Profile"));
  prof.append(el("p", "situationtext", data.profile || "Not set."));
  if (data.signoff) prof.append(el("p", "kbdhint", "Sign-off: " + data.signoff));
  const edit = el("button", "btn small", demo ? "Open profile" : "Edit profile");
  edit.type = "button";
  edit.addEventListener("click", openProfile);
  const pr = el("div", "actions");
  pr.append(edit);
  prof.append(pr);
  const sit = el("div", "situation");
  renderSituation(sit, data.situation || [], demo, reload);
  const ppl = el("div", "situation people");
  renderPeople(ppl, data.people || [], demo, reload);
  box.append(prof, sit, ppl);
  const mig = data.migration;
  if (mig && (mig.skipped_owner_address || []).length) {
    box.append(el("p", "kbdhint", "When notes moved to people, " + mig.skipped_owner_address.length +
      " note on your own address was left out: " + mig.skipped_owner_address.join(", ") + "."));
  }
}

function addrText(p, a) {
  // An address as the page shows it: a Slack user key as "Name (Slack)", an old Slack name as
  // itself, marked when it is not linked to a user; anything else (an email address) as is.
  const l = (p.address_labels || {})[a];
  if (!l) return a;
  if (l.kind === "slack") return l.text + " (Slack)";
  if (l.kind === "slack_unlinked") return l.text + " (Slack name, not linked to a user)";
  return l.text + " (old Slack name)";
}

function addrLine(p, addrs, prefix) {
  // The address line. With a Slack key in it, one span per address, the key in that span's
  // title only (hover shows it; the text never does).
  const labels = p.address_labels || {};
  if (!addrs.some(a => (labels[a] || {}).kind === "slack")) {
    return el("p", "kbdhint personaddrs", prefix + addrs.map(a => addrText(p, a)).join(", "));
  }
  const line = el("p", "kbdhint personaddrs", prefix);
  addrs.forEach((a, i) => {
    const span = el("span", null, (i ? ", " : "") + addrText(p, a));
    if ((labels[a] || {}).kind === "slack") span.title = a;
    line.append(span);
  });
  return line;
}

function personTitle(p) {
  const first = (p.addresses || [])[0];
  return p.name || (first ? addrText(p, first) : "(no address)");
}

function renderPeople(box, people, demo, reload) {
  // people: [{id, name, note, author, created_at, updated_at, addresses, mail_names,
  // address_labels}], newest first.
  box.replaceChildren(el("h3", null, "People"));
  const act = async (kind, extra, failMsg) => {
    try { await postAction(kind, "", Object.assign({ author: "owner" }, extra)); reload(); }
    catch (e) { toast(failMsg + ": " + e.message); }
  };
  if (!people.length) {
    box.append(el("p", "kbdhint", demo ? "Demo: nothing is remembered here. In your own copy, " +
      "notes you save from Ask appear here." : "No one yet. Notes you save from Ask appear here."));
  }
  for (const p of people) {
    const li = el("div", "situationitem person");
    const title = el("p", "personname", personTitle(p));
    const first = (p.addresses || [])[0];
    if (!p.name && ((p.address_labels || {})[first] || {}).kind === "slack") title.title = first;
    // Unnamed: the title already is the address, so list only the others (no repeat).
    const rest = p.name ? (p.addresses || []) : (p.addresses || []).slice(1);
    const parts = [title];
    if (rest.length) parts.push(addrLine(p, rest, p.name ? "" : "also "));
    if (!p.name && (p.mail_names || []).length) {
      parts.push(el("p", "kbdhint unconfirmed", "From mail, unconfirmed: " + p.mail_names.join(", ")));
    }
    parts.push(el("p", "situationtext", p.note),
               el("p", "kbdhint authorlabel", authorLabel(p.author, p.updated_at)));
    const row = el("div", "actions");
    if (!demo) {
      const edit = el("button", "btn small", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => {
        const nameLabel = el("label", "kbdhint", "Name (only you set this; mail never does)");
        const name = el("input", "nameinput");
        name.type = "text";
        name.maxLength = 100;
        name.value = p.name || "";
        name.id = "person-name-" + p.id;
        nameLabel.htmlFor = name.id;
        const ta = el("textarea");
        ta.rows = 3;
        ta.maxLength = 2000;
        ta.value = p.note;
        const sv = el("button", "btn small primary", "Save");
        sv.type = "button";
        sv.addEventListener("click", () => {
          if (!ta.value.trim()) { toast("A note needs text. To remove the person, use Delete."); return; }
          act("person_update", { id: p.id, text: ta.value, name: name.value }, "Save failed");
        });
        const cancel = el("button", "btn small", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", reload);
        const r2 = el("div", "actions");
        r2.append(sv, cancel);
        li.replaceChildren(addrLine(p, p.addresses || [], ""), nameLabel, name, ta, r2);
        name.focus();
      });
      row.append(edit);
      if (p.author !== "owner") {
        const ok = el("button", "btn small", "Confirm");
        ok.type = "button";
        ok.title = "Mark this note as yours, as written";
        ok.addEventListener("click", () => act("person_confirm", { id: p.id }, "Confirm failed"));
        row.append(ok);
      }
      const del = el("button", "btn small", "Delete");
      del.type = "button";
      del.title = "Forget this person, their addresses and their note";
      del.addEventListener("click", () => act("person_delete", { id: p.id }, "Delete failed"));
      row.append(del);
      const others = people.filter(o => o.id !== p.id);
      if (others.length) {
        const merge = el("button", "btn small", "Merge into...");
        merge.type = "button";
        merge.addEventListener("click", () => mergeStep(li, p, others, act, reload));
        row.append(merge);
      }
    }
    parts.push(row);
    li.append(...parts);
    box.append(li);
  }
}

function mergeStep(li, p, others, act, reload) {
  // Pick who to merge into, then confirm: merging cannot be undone.
  const pick = el("select", "modelpick");
  pick.append(Object.assign(el("option", null, "Choose a person"), { value: "" }));
  for (const o of others) {
    pick.append(Object.assign(el("option", null, personTitle(o) + " (" + o.addresses.map(a => addrText(o, a)).join(", ") + ")"),
                              { value: String(o.id) }));
  }
  const next = el("button", "btn small", "Merge");
  next.type = "button";
  const cancel = el("button", "btn small", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", reload);
  const r = el("div", "actions");
  r.append(pick, next, cancel);
  li.replaceChildren(el("p", "personname", "Merge " + personTitle(p) + " into..."), r);
  next.addEventListener("click", () => {
    const into = others.find(o => String(o.id) === pick.value);
    if (!into) { toast("Choose who to merge into."); return; }
    const yes = el("button", "btn small primary", "Yes, merge");
    yes.type = "button";
    yes.addEventListener("click", () => act("person_merge", { id: p.id, into: into.id }, "Merge failed"));
    const no = el("button", "btn small", "Cancel");
    no.type = "button";
    no.addEventListener("click", reload);
    const r2 = el("div", "actions");
    r2.append(yes, no);
    li.replaceChildren(el("p", "personname", "Merge " + personTitle(p) + " into " + personTitle(into) + "?"),
      el("p", "kbdhint", (p.addresses || []).map(a => addrText(p, a)).join(", ") + " and this note move to " + personTitle(into) +
        ", and " + personTitle(p) + " is removed. This cannot be undone."), r2);
  });
}

// ---- Keyboard shortcuts, after Gmail's: j/k move, o or Enter open and close, u only closes, e archive,
// r reply, m memory, ? help. Never while typing in a box, and never with Ctrl/Cmd/Alt held.
const SHORTCUTS = [
  ["/", "Search: type to filter, Enter searches all of Gmail"],
  ["j / k", "Next / previous thread"],
  ["o or Enter", "Open the thread; press again to close it"],
  ["u", "Close the thread (never opens one)"],
  ["e", "Archive (Gmail) or Done (Slack)"],
  ["s", "Star or unstar (Gmail: in Gmail too; Slack: in FrontDesk only)"],
  ["r", "Reply (jump to the reply box)"],
  ["v", "Move to another section"],
  ["m", "Memory: everything FrontDesk remembers"],
  ["?", "Show or hide this list"],
  ["Esc", "Leave the reply box / close this list"],
];
let currentId = null;

function allCards() {
  return [...document.querySelectorAll("main .list > li.card")];
}

function visibleCards() {
  // A collapsed section's rows can still have layout in current browsers (closed <details>
  // content is hidden, not removed), so check the section itself, not just offsetParent.
  return allCards().filter(li => li.offsetParent !== null && !li.closest("details:not([open])"));
}

function setCurrent(li) {
  for (const c of document.querySelectorAll("li.card.current")) c.classList.remove("current");
  if (!li) { currentId = null; return; }
  li.classList.add("current");
  currentId = li.dataset.id;
  li.scrollIntoView({ block: "nearest" });
  // Keep one selection on screen: if a row button holds focus (after a click), move focus to the
  // new current row so its focus ring does not stay behind on the old one.
  const a = document.activeElement;
  if (a && a.classList && a.classList.contains("row") && a.closest("li.card") !== li) {
    const row = li.querySelector(":scope > .row");
    if (row) row.focus({ preventScroll: true });
  }
}

function currentCard() {
  const cards = visibleCards();
  return cards.find(li => li.dataset.id === currentId) || null;
}

function move(step) {
  const cards = visibleCards();
  const i = cards.findIndex(li => li.dataset.id === currentId);
  // j past the last visible row opens the next collapsed section (Ignore) and selects its first
  // row, so the keyboard never lands on a hidden thread.
  if (step > 0 && (i === cards.length - 1 || !cards.length)) {
    const all = allCards();
    const from = i < 0 ? -1 : all.indexOf(cards[i]);
    const hidden = all.slice(from + 1).find(li => li.closest("details:not([open])"));
    if (hidden) {
      const det = hidden.closest("details");
      det.open = true;
      setCurrent(hidden);
      return;
    }
  }
  if (!cards.length) return;
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
    if (t && t.id === "search") { clearSearch(); return; }
    if (!typing && query && document.getElementById("help").hidden &&
        document.getElementById("profilepanel").hidden) { clearSearch(); return; }
    if (typing) t.blur();
    for (const s of document.querySelectorAll(".peoplestrip")) if (s.closeEditor) s.closeEditor();
    toggleHelp(false);
    document.getElementById("profilepanel").hidden = true;
    return;
  }
  if (typing) return;
  const li = currentCard();
  // A search result is not a stored thread: only moving and opening apply to it.
  if (li && li.classList.contains("result") && "esvru".includes(e.key)) return;
  switch (e.key) {
    case "/": {
      const box = document.getElementById("search");
      if (box) { box.focus(); box.select(); }
      break;
    }
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
      if (li) dismissCard(li);
      break;
    case "s":
      if (li && cardItems.get(li)) toggleStar(cardItems.get(li));
      break;
    case "v":
      if (li) {
        if (!isOpen(li)) li.querySelector(":scope > .row").click();
        const mp = li.querySelector("select.movepick");
        if (mp) {
          mp.focus();
          try { if (mp.showPicker) mp.showPicker(); } catch (err) { /* focus is enough; Space opens it */ }
        }
      }
      break;
    case "r":
      if (li) {
        if (!isOpen(li)) li.querySelector(":scope > .row").click();
        const ta = li.querySelector(".reply textarea");
        if (ta) { ta.focus(); ta.scrollIntoView({ block: "center" }); }
      }
      break;
    case "m": openMemory(); break;
    case "?": toggleHelp(); break;
    default: return;
  }
  e.preventDefault();
}

// ---- Auto-sync: the server syncs on its own; the page notices a newer result and refreshes,
// unless a thread is open or you are typing, in which case it offers a refresh instead.
let lastSyncSeen = null;

function busy() {
  const a = document.activeElement;
  const typing = a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT");
  const open = document.querySelector('main .row[aria-expanded="true"]');
  const panel = !document.getElementById("profilepanel").hidden;
  return typing || open || panel;
}

function showSyncLine(s) {
  const note = document.getElementById("syncnote");
  if (!s.at) {
    note.textContent = s.auto_sync_minutes ? "Auto-sync every " + s.auto_sync_minutes + " min" : "";
    return;
  }
  const when = new Date(Date.parse(s.at)).toLocaleTimeString(undefined,
    { hour: "numeric", minute: "2-digit" });
  note.textContent = (s.ok === false ? "Sync failed " + when + ": " + s.summary : "Synced " + when) +
    (s.auto_sync_minutes ? ", auto every " + s.auto_sync_minutes + " min" : "");
}

async function pollStatus() {
  if (STATIC) return;
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) return;
    const s = await res.json();
    const changed = lastSyncSeen !== null && s.at && s.at !== lastSyncSeen;
    lastSyncSeen = s.at || "";
    showSyncLine(s);
    if (changed) {
      if (!busy()) {
        await load();
      } else {
        const note = document.getElementById("syncnote");
        const r = el("button", "linkbtn", "New results: refresh");
        r.type = "button";
        r.addEventListener("click", () => load());
        note.append(" ", r);
      }
    }
  } catch (e) { /* the next poll will try again */ }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("sync").addEventListener("click", syncNow);
  document.getElementById("profile").addEventListener("click", openProfile);
  document.getElementById("memory").addEventListener("click", openMemory);
  buildHelp();
  setupSearch();
  document.addEventListener("keydown", onKey);
  load();
  pollStatus();
  setInterval(pollStatus, 60000);
});
