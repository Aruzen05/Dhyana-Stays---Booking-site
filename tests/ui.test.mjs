// Full-stack UI test: real index.html/admin.html + site.js/admin.js in jsdom
//   → emulated Supabase (PostgREST/Auth/Storage) on PGlite running setup.sql
//   → real booking-api edge function → mocked Razorpay.
// usage: node ui.test.mjs <pgdeps> <stay-template dir>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";

const [deps, root] = process.argv.slice(2);
const req = createRequire(path.join(deps, "package.json"));
const { JSDOM, ResourceLoader, VirtualConsole } = req("jsdom");
const pg = await import(pathToFileURL(path.join(deps, "node_modules/@electric-sql/pglite/dist/index.js")).href);
const { btree_gist } = await import(pathToFileURL(path.join(deps, "node_modules/@electric-sql/pglite/dist/contrib/btree_gist.js")).href);
const fatal = (e) => { console.log("FATAL:", e?.message, e?.stack?.split("\n").slice(1, 5).join(" | ")); process.exit(1); };
process.on("uncaughtException", fatal); process.on("unhandledRejection", fatal);

let pass = 0, fail = 0;
// Emoji and pictograph ranges (arrows like → and ↗, ₹, © and · are ordinary text and allowed).
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{FE0F}]/u;
const emojiIn = (html) => (html.match(EMOJI) || [""])[0];
const ok = (c, name, extra = "") => { if (c) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(25); } return null; }

// ---------------- database ----------------
const isoTs = (v) => v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
const db = new pg.PGlite({ extensions: { btree_gist }, parsers: { 1082: (v) => v, 1114: (v) => v.replace(" ", "T"), 1184: isoTs } });
const fld = (form, name) => form.elements.namedItem(name);
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema extensions; create schema auth; create schema storage;
  create table auth.users (id uuid primary key, email text, password text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
  grant all on storage.objects to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`);
await db.exec(readFileSync(path.join(root, "supabase/setup.sql"), "utf8"));
const ADMIN = randomUUID(), OTHER = randomUUID();
await db.query(`insert into auth.users values ($1,'owner@example.com','correct horse 1'), ($2,'other@example.com','other pass 12')`, [ADMIN, OTHER]);
await db.query(`insert into public.admins (user_id) values ($1)`, [ADMIN]);
// a room description containing HTML, to prove it's escaped on the site
await db.exec(`update public.rooms set description = '<img src=x onerror="window.__xss=1">Lovely' where id = 'garden-room'`);

let qlock = Promise.resolve();
function asRole(role, sub, fn) {     // serialise role-switched queries on the single PGlite connection
  const run = qlock.then(async () => {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${sub || ""}', false); ${role === "postgres" ? "" : `set role ${role};`}`);
    try { return await fn(); } finally { await db.exec("reset role;"); }
  });
  qlock = run.catch(() => {});
  return run;
}

// ---------------- emulated Supabase ----------------
const SB = "https://proj.supabase.co", ANON = "anon-key-123", SERVICE = "service-key-abcdefghijklmnopqrstuvwxyz";
const ORIGIN = "https://www.example-stay.com";
const RZP_SECRET = "rzp_secret_123";
const tokens = new Map();           // access token → user id
const J = (data, status = 200) => new Response(data === undefined ? "" : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const pgErr = (e) => J({ code: e.code, message: e.message }, e.code === "42501" ? 403 : 400);
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error("bad ident " + s); return s; };

function who(headers) {
  const key = headers.get("apikey"); const auth = (headers.get("authorization") || "").replace(/^Bearer /, "");
  if (key === SERVICE) return ["service_role", ""];
  if (tokens.has(auth)) return ["authenticated", tokens.get(auth)];
  if (auth && auth !== ANON) return ["bad", ""];
  return ["anon", ""];
}

async function postgrest(url, init, headers) {
  const [role, sub] = who(headers);
  if (role === "bad") return J({ code: "PGRST301", message: "JWT expired" }, 401);
  const u = new URL(url);
  const parts = u.pathname.replace(/^\/rest\/v1\//, "").split("/");
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : {};
  try {
    if (parts[0] === "rpc") {
      const fn = ident(parts[1]); const keys = Object.keys(body);
      const res = await asRole(role, sub, () => db.query(`select * from public.${fn}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")})`, keys.map((k) => body[k])));
      if (res.fields.length === 1 && res.fields[0].name === fn) { const v = res.rows[0]?.[fn]; return v === null || v === "" ? new Response("", { status: 200 }) : J(v); }
      return J(res.rows);
    }
    const table = ident(parts[0]);
    const where = [], params = [];
    let select = "*", order = "", limit = "", offset = "";
    for (const [k, v] of u.searchParams) {
      if (k === "select") select = v === "*" ? "*" : v.split(",").map(ident).join(",");
      else if (k === "order") order = " order by " + v.split(",").map((o) => { const [c, d] = o.split("."); return `${ident(c)} ${d === "desc" ? "desc" : "asc"}`; }).join(",");
      else if (k === "limit") limit = ` limit ${Number(v)}`;
      else if (k === "offset") offset = ` offset ${Number(v)}`;
      else { const m = /^eq\.(.*)$/.exec(v); if (!m) throw new Error("unsupported filter " + v); params.push(m[1]); where.push(`${ident(k)}::text = $${params.length}`); }
    }
    const w = where.length ? " where " + where.join(" and ") : "";
    let sql;
    if (method === "GET") sql = `select ${select} from public.${table}${w}${order}${limit}${offset}`;
    else if (method === "PATCH") {
      const keys = Object.keys(body).map(ident);
      params.push(JSON.stringify(body));
      sql = `update public.${table} t set ${keys.map((k) => `${k} = (x.r).${k}`).join(", ")} from (select json_populate_record(null::public.${table}, $${params.length}::json) r) x${w.replace(/(\w+)::text/g, "t.$1::text")} returning t.*`;
    } else if (method === "POST") {
      const keys = Object.keys(body).map(ident);
      params.push(JSON.stringify(body));
      sql = `insert into public.${table} (${keys.join(",")}) select ${keys.map((k) => `(r).${k}`).join(",")} from (select json_populate_record(null::public.${table}, $${params.length}::json) r) x returning *`;
    } else if (method === "DELETE") sql = `delete from public.${table}${w} returning *`;
    const res = await asRole(role, sub, () => db.query(sql, params));
    return J(res.rows, method === "POST" ? 201 : 200);
  } catch (e) { return pgErr(e); }
}

async function gotrue(url, init, headers) {
  const u = new URL(url); const p = u.pathname.replace("/auth/v1/", ""); const body = init.body ? JSON.parse(init.body) : {};
  const issue = (user) => { const t = "tok-" + randomUUID(); tokens.set(t, user.id); return J({ access_token: t, refresh_token: "r-" + user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: { id: user.id, email: user.email } }); };
  if (p === "token" && u.searchParams.get("grant_type") === "password") {
    const r = await db.query(`select id, email from auth.users where email = $1 and password = $2`, [body.email, body.password]);
    return r.rows[0] ? issue(r.rows[0]) : J({ code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400);
  }
  if (p === "token") { const id = String(body.refresh_token).slice(2); const r = await db.query(`select id, email from auth.users where id::text = $1`, [id]); return r.rows[0] ? issue(r.rows[0]) : J({ error_code: "refresh_token_not_found" }, 400); }
  const t = (headers.get("authorization") || "").replace(/^Bearer /, "");
  if (p === "user" && (init.method || "GET") === "GET") { const id = tokens.get(t); return id ? J({ id, email: "owner@example.com" }) : J({ msg: "JWT expired" }, 401); }
  if (p === "user") { const id = tokens.get(t); if (!id) return J({}, 401); await db.query(`update auth.users set password = $1 where id = $2`, [body.password, id]); return J({ id }); }
  if (p === "logout") { tokens.delete(t); return new Response(null, { status: 204 }); }
  if (p === "recover") return J({});
  return J({}, 404);
}

const deletedFiles = [];
async function storage(url, init, headers) {
  const [role, sub] = who(headers);
  const name = new URL(url).pathname.replace("/storage/v1/object/room-images/", "");
  if ((init.method || "GET").toUpperCase() === "DELETE") {
    const r = await asRole(role, sub, () => db.query(`delete from storage.objects where bucket_id = 'room-images' and name = $1 returning name`, [name]));
    if (!r.rows.length) return J({ statusCode: "404", error: "not_found", message: "Object not found" }, 404);
    deletedFiles.push(name);
    return J([{ name }]);
  }
  try { await asRole(role, sub, () => db.query(`insert into storage.objects (bucket_id, name) values ('room-images', $1)`, [name])); return J({ Key: "room-images/" + name }); }
  catch (e) { return J({ statusCode: "403", error: "Unauthorized", message: e.message }, 403); }
}

// edge function (real code) with its outbound fetch routed back into this emulator
let edge;
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: SERVICE, RAZORPAY_KEY_ID: "rzp_test_KEY", RAZORPAY_KEY_SECRET: RZP_SECRET,
  RAZORPAY_WEBHOOK_SECRET: "wh", ALLOWED_ORIGINS: ORIGIN, IP_HASH_SALT: "s" })[k] }, serve: (h) => { edge = h; } };
let orderSeq = 0;
async function route(url, init = {}) {
  url = String(url);
  const headers = new Headers(init.headers);
  if (url.startsWith(SB + "/rest/v1/")) return postgrest(url, init, headers);
  if (url.startsWith(SB + "/auth/v1/")) return gotrue(url, init, headers);
  if (url.startsWith(SB + "/storage/v1/object/room-images/")) return storage(url, init, headers);
  if (url.startsWith(SB + "/functions/v1/")) { headers.set("origin", ORIGIN); headers.set("x-forwarded-for", "198.51.100.7"); return edge(new Request(url, { method: init.method, headers, body: init.body })); }
  if (url === "https://api.razorpay.com/v1/orders") { const b = JSON.parse(init.body); return J({ id: "order_UI" + (++orderSeq), amount: b.amount, currency: b.currency }); }
  throw new Error("unexpected fetch " + url);
}
globalThis.fetch = route;
await import(pathToFileURL(path.join(root, "supabase/functions/booking-api/index.ts")).href);

// ---------------- jsdom loader ----------------
class Loader extends ResourceLoader {
  fetch(url) {
    if (url.startsWith(ORIGIN + "/")) {
      let text = readFileSync(path.join(root, "web", new URL(url).pathname));
      if (url.endsWith("/config.js")) text = Buffer.from(String(text)
        .replace("https://YOUR-PROJECT-REF.supabase.co", SB).replace("YOUR-ANON-OR-PUBLISHABLE-KEY", ANON)
        .replace('title: "Dhyana",', 'title: "<img src=x onerror=window.__xss=2>Dhyana",'));
      return Promise.resolve(text);
    }
    return Promise.resolve(Buffer.from(""));      // external CSS/fonts: ignore
  }
}
const errors = [];
async function openPage(file, hash = "") {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(`${file}: ${e.message}`));
  vc.on("error", (...a) => errors.push(`${file}: console.error ${a.map(String).join(" ").slice(0, 200)}`));
  const dom = new JSDOM(readFileSync(path.join(root, "web", file), "utf8"), {
    url: `${ORIGIN}/${file}${hash}`, runScripts: "dangerously", resources: new Loader(), pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (u, i) => route(u, i);
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.URL.createObjectURL = (blob) => { w.__lastBlob = blob; return "blob:x"; };
      w.URL.revokeObjectURL = () => {};
      w.confirm = () => true; w.alert = (m) => errors.push(`${file}: alert ${m}`);
      w.HTMLAnchorElement.prototype.click = function () { w.__downloaded = this.download; };
    },
  });
  await new Promise((r) => dom.window.addEventListener("load", r));
  return dom.window;
}

const dbq = async (sql, p) => (await asRole("postgres", "", () => db.query(sql, p))).rows;
const today = (await dbq(`select public.local_today()::text d`))[0].d;
const day = (n) => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let mon = 14; while (new Date(day(mon) + "T00:00:00Z").getUTCDay() !== 1) mon++;

// =====================================================================
console.log("public site");
let w = await openPage("index.html");
let $ = (s) => w.document.querySelector(s);
const cards = await until(() => w.document.querySelectorAll("#rooms .room-card").length === 2);
ok(cards, "rooms load from the database");
ok($(".nav-brand").textContent === "Dhyana Stays" && $(".brand-mark")?.getAttribute("src") === "images/logo.svg", "Dhyana Stays name + logo from config.js");
ok(!w.document.querySelector(".hero img") && $(".hero-title").textContent.includes("<img"), "HTML in config text is shown as text, not run");
ok(!w.document.querySelector("#rooms img[src='x']") && $("#rooms").textContent.includes('<img src=x onerror="window.__xss=1">Lovely'), "HTML in room descriptions is escaped");
ok(w.__xss === undefined, "no injected script ran");
ok(w.document.querySelector("script[type='application/ld+json']")?.textContent.includes('"LodgingBusiness"'), "search-engine data generated");
ok(w.document.querySelectorAll("#highlights li").length === 4 && w.document.querySelectorAll("#contact-grid .card").length === 3, "highlights + contact cards rendered");
ok(w.document.querySelectorAll("#highlights li svg.hl-icon").length === 4 && w.document.querySelectorAll("#contact-grid .contact-icon svg").length === 3, "highlights and contact cards use drawn icons");
ok(await until(() => /\+91 98400 36900/.test($("#contact-grid").textContent) && /support@dhyanastays\.com/.test($("#contact-grid").textContent) && /ECR Road, Auroville/.test($("#footer-line").textContent)), "contact details come from the database (admin settings), not config.js");
ok(!$("#loc-finder").hidden && w.document.querySelectorAll("#loc-tabs .loc-tab").length === 1 && /Auroville/.test($("#loc-tabs").textContent) && /Auroville/.test($("#loc-intro").textContent), "one location → place search + one place button, location intro shown");
const typePlace = (win, v) => { const q = win.document.querySelector("#loc-q"); q.value = v; q.dispatchEvent(new win.Event("input", { bubbles: true })); };
typePlace(w, "pondicherry");
ok(w.document.querySelectorAll("#rooms .room-card").length === 2 && /2 stays in Auroville/.test($("#loc-status").textContent), "search “pondicherry” finds the Auroville stays (matches its area)", $("#loc-status").textContent);
typePlace(w, "Goa");
ok(!w.document.querySelector("#rooms .room-card") && /No stays found for “Goa”/.test($("#loc-status").textContent) && /don't have a stay matching “Goa”/.test($("#rooms").textContent) && !$("#loc-intro").textContent.trim(), "a place with no stays → clear message, no cards");
typePlace(w, '<img src=x onerror="window.__xss=3">');
ok(!w.document.querySelector("#rooms img[src='x']") && /<img src=x/.test($("#rooms").textContent) && w.__xss === undefined, "search text is shown as text, not run");
$("[data-action=loc-all]").click();
ok(w.document.querySelectorAll("#rooms .room-card").length === 2 && $("#loc-q").value === "" && $(".loc-clear").hidden, "“Show all stays” clears the search");
ok(!emojiIn(w.document.body.innerHTML), "no emoji anywhere on the website", emojiIn(w.document.body.innerHTML));
const setMoney = (win, id, v) => { const i = win.document.querySelector(id); i.value = v; i.dispatchEvent(new win.Event("input", { bubbles: true })); };
const setWeekend = (win, v) => { const sl = win.document.querySelector("#sf-weekend"); sl.value = v; sl.dispatchEvent(new win.Event("change", { bubbles: true })); };
const cardNames = (win) => [...win.document.querySelectorAll("#rooms .room-card h3")].map((h) => h.textContent).join(",");
ok(!$("#stay-filters").hidden && !$("#sf-weekend-field").hidden && $(".sf-clear").hidden, "price filters shown (stays have prices and a weekend rate)");
setMoney(w, "#sf-min", "3000");
ok(cardNames(w) === "Garden Room" && !$(".sf-clear").hidden && /1 stay in Auroville/.test($("#loc-status").textContent), "min ₹3,000 → only priced stays at or above it (price-on-request drops out)", cardNames(w));
$(".nav-links [data-action=book]").click();
ok(await until(() => !$("#booking").hidden && $("#bk-rooms .room-chosen") && /Garden Room/.test($("#bk-rooms").textContent)), "“Book now” offers what the filters show");
$("[data-action=close]").click();
setMoney(w, "#sf-min", "3200"); setMoney(w, "#sf-max", "2800");
ok(cardNames(w) === "Garden Room", "min and max typed the wrong way round still work (₹2,800–3,200)", cardNames(w));
setMoney(w, "#sf-min", "3600"); setMoney(w, "#sf-max", "");
ok(!w.document.querySelector("#rooms .room-card") && /No stays match these filters/.test($("#rooms").textContent) && w.document.querySelector("#rooms [data-action=filters-clear]"), "nothing from ₹3,600 → clear message with “Clear filters”");
setMoney(w, "#sf-min", ""); setMoney(w, "#sf-max", "3200");
ok(cardNames(w) === "Garden Room", "max ₹3,200 uses the lowest nightly rate (₹3,000 weekdays)", cardNames(w));
setWeekend(w, "special");
ok(!w.document.querySelector("#rooms .room-card") && /Weekend price per night/.test($("#sf-price-label").textContent) && /Highest weekend price/.test($("#sf-max-name").textContent), "with “Special weekend price” the range uses the weekend rate (₹3,500 > ₹3,200)");
setMoney(w, "#sf-max", "");
ok(cardNames(w) === "Garden Room", "“Special weekend price” on its own → stays with a separate weekend rate", cardNames(w));
setWeekend(w, "same");
ok(!w.document.querySelector("#rooms .room-card"), "“Same price every day” → none here (the only priced stay has a weekend rate)");
w.document.querySelector("#rooms [data-action=filters-clear]").click();
ok(w.document.querySelectorAll("#rooms .room-card").length === 2 && $("#sf-weekend").value === "" && $("#sf-min").value === "" && $(".sf-clear").hidden, "“Clear filters” shows every stay again");

async function openRoom(roomId) {
  w.document.querySelector(`[data-action=book][data-room='${roomId}']`).click();
  return until(() => !$("#booking").hidden && w.document.querySelector(`#bk-cal .day[data-date]`));
}
async function goToMonth(date) {
  for (let i = 0; i < 24 && !w.document.querySelector(`.day[data-date='${date}']`); i++) $("[data-action=cal-next]").click();
  return w.document.querySelector(`.day[data-date='${date}']`);
}
async function pickRange(ci, co) {
  (await goToMonth(ci)).click();
  (await goToMonth(co)).click();
}
function fill(name, email, phone) { $("#bk-name").value = name; $("#bk-email").value = email; $("#bk-phone").value = phone; }

ok(await openRoom("garden-room"), "booking dialog opens on the room with its calendar");
ok($("#bk-rooms .room-chosen") && !$("#bk-rooms .room-option") && /Garden Room/.test($("#bk-rooms").textContent) && /Your room/.test($("#bk-room-label").textContent), "room chosen on the page → dialog shows just that room, not the list");
ok(w.document.querySelector(`.day[data-date='${day(-1)}']`)?.disabled !== false, "past days can't be picked");
await pickRange(day(mon), day(mon + 2));
const quoted = await until(() => /₹6,000/.test($("#bk-quote").textContent) && $("#bk-pay").textContent);
ok(quoted && $("#bk-pay").textContent === "Pay ₹6,000 now", "server quote shown: 2 nights × ₹3,000", $("#bk-quote").textContent);
ok(!$("#bk-arrival").hidden, "pay-on-arrival offered");
$("#bk-pay").click();
ok(await until(() => !$("#bk-error").hidden && /name/.test($("#bk-error").textContent)), "missing name → clear error, nothing sent");
fill("Asha Rao", "asha@example.com", "abc");
$("#bk-pay").click();
ok(await until(() => /phone/.test($("#bk-error").textContent)), "bad phone → clear error");

// Razorpay mock: completes payment and calls the handler with a genuine signature
w.Stay.loadScript = async () => {};
let rzpOpts;
w.Razorpay = class { constructor(o) { rzpOpts = o; } on() {} open() { const pid = "pay_UI" + orderSeq; setTimeout(() => rzpOpts.handler({ razorpay_order_id: rzpOpts.order_id, razorpay_payment_id: pid, razorpay_signature: createHmac("sha256", RZP_SECRET).update(`${rzpOpts.order_id}|${pid}`).digest("hex") }), 5); } };
fill("Asha Rao", "asha@example.com", "+91 98765 43210");
$("#bk-pay").click();
const done = await until(() => !$("#bk-done").hidden && /Booking confirmed/.test($("#bk-done").textContent));
ok(done, "online payment → 'Booking confirmed!' screen", $("#bk-done").textContent.slice(0, 200) + " | " + $("#bk-error").textContent);
ok($("#bk-done .done-icon svg") && !emojiIn($("#bk-done").innerHTML), "confirmation uses a drawn icon, no emoji", emojiIn($("#bk-done").innerHTML));
ok(rzpOpts?.amount === 600000 && rzpOpts.prefill.email === "asha@example.com", "Razorpay opened with the server amount and guest prefill");
ok(/DS\/\d\d-\d\d\/0001/.test($("#bk-done").textContent), "invoice number shown to guest");
ok($("[data-action=download]")?.textContent.includes("invoice"), "invoice download offered");
const inv = w.Stay.invoiceHTML((await dbq(`select to_jsonb(b) j from public.bookings b where guest_email = 'asha@example.com'`))[0].j);
ok(/PAYMENT RECEIPT/.test(inv) && /DS\/\d\d-\d\d\/0001/.test(inv) && /Supplier not registered under GST/.test(inv), "invoice: receipt (GST off), number, and no-GST note");
// PDF page: the whole receipt must land on one A4 page (it used to be cut off on the right)
{
  const pdfCalls = {};
  w.html2canvas = async () => ({ width: 1588, height: 1366, toDataURL: () => "data:image/jpeg;base64,AA" });
  w.jspdf = { jsPDF: class { constructor(o) { pdfCalls.opts = o; this.internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } }; }
    addImage(...a) { pdfCalls.img = a; } save(n) { pdfCalls.name = n; } } };
  await w.Stay.downloadInvoice((await dbq(`select to_jsonb(b) j from public.bookings b where guest_email = 'asha@example.com'`))[0].j);
  const [, , x, y, iw, ih] = pdfCalls.img || [];
  ok(pdfCalls.opts?.format === "a4" && x >= 0 && y >= 0 && x + iw <= 210.01 && y + ih <= 297.01 && Math.abs(iw / ih - 1588 / 1366) < 0.01 && /^DhyanaStays-Invoice-DS-\d\d-\d\d-0001\.pdf$/.test(pdfCalls.name),
    "invoice PDF: A4 page, whole receipt fits on it", JSON.stringify(pdfCalls));
  delete w.html2canvas; delete w.jspdf;
}
ok((await dbq(`select status, payment_status from public.bookings where guest_email='asha@example.com'`))[0].status === "confirmed", "database: booking confirmed + paid");

$("[data-action=close]").click();
await openRoom("garden-room");
const partial = await goToMonth(day(mon));
ok(partial.classList.contains("partial") && !partial.disabled, "calendar now shows 1 of 2 units free on those nights");
await pickRange(day(mon), day(mon + 2));
await until(() => /₹6,000/.test($("#bk-quote").textContent));
fill("Ben Das", "ben@example.com", "+91 90000 11111");
$("#bk-arrival").click();
ok(await until(() => /Request received/.test($("#bk-done").textContent)), "pay on arrival → 'Request received' with hold time");
ok(/booking summary/i.test($("[data-action=download]")?.textContent || ""), "booking summary (not invoice) offered for unpaid hold");

$("[data-action=close]").click();
await openRoom("garden-room");
const full = await goToMonth(day(mon));
ok(full.classList.contains("full") && full.disabled, "fully booked nights are struck out and unclickable");

$("[data-action=close]").click();
$(".nav-links [data-action=book]").click();
ok(await until(() => !$("#booking").hidden && w.document.querySelectorAll("#bk-rooms .room-option").length === 2 && /Choose a room/.test($("#bk-room-label").textContent)), "“Book now” with no room chosen → list of rooms");
$("[data-action=close]").click();
await openRoom("garden-room");
$("[data-action=room-change]").click();
ok(w.document.querySelectorAll("#bk-rooms .room-option").length === 2 && $("#bk-rooms .room-option.selected")?.dataset.room === "garden-room", "“Change” lists the rooms with the current one selected");
$("#bk-rooms .room-option[data-room='cottage']").click();
ok(await until(() => $("#bk-rooms .room-chosen") && /Cottage/.test($("#bk-rooms").textContent) && !$("#bk-rooms .room-option")), "picking another room shows just that room again");
$("[data-action=close]").click();
await openRoom("cottage");
await pickRange(day(mon + 3), day(mon + 4));
await until(() => !$("#bk-inquiry").hidden && !$("#bk-inquiry").disabled);
ok($("#bk-pay").hidden && /Price on request/.test($("#bk-quote").textContent), "unpriced room → inquiry only, no payment");
fill("<b>Cy</b>", "cy@example.com", "+91 90000 22222");
$("#bk-inquiry").click();
ok(await until(() => /Inquiry sent/.test($("#bk-done").textContent)), "inquiry submitted");
ok(!$("#bk-done").querySelector("b b") && $("#bk-done").textContent.includes("<b>Cy</b>"), "guest name with HTML is escaped on the confirmation screen");

// =====================================================================
console.log("admin dashboard");
w = await openPage("admin.html");
$ = (s) => w.document.querySelector(s);
ok(await until(() => !$("#auth").hidden && !$("#f-login").hidden), "login screen shown");
const login = async (email, pw) => { $("#login-email").value = email; $("#login-pw").value = pw; $("#f-login").dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true })); };
await login("owner@example.com", "wrong");
ok(await until(() => /Wrong email or password/.test($("#login-err").textContent)), "wrong password refused");
await login("other@example.com", "other pass 12");
ok(await until(() => /isn't set up as an admin/.test($("#login-err").textContent)), "valid login without admin role refused");
await login("owner@example.com", "correct horse 1");
ok(await until(() => !$("#app").hidden && w.document.querySelectorAll("#bk-rows tr").length >= 1), "admin logs in and sees bookings");
ok(/Needs action\s*1/.test($("#status-chips").textContent), "pay-on-arrival request appears under 'Needs action'", $("#status-chips").textContent);
w.document.querySelector("[data-chip=all]").click();
ok(w.document.querySelectorAll("#bk-rows tr").length === 3, "all three bookings listed");
const benRow = [...w.document.querySelectorAll("#bk-rows tr")].find((tr) => tr.textContent.includes("Ben Das"));
benRow.click();
ok(await until(() => !$("#dlg").hidden && $("[data-action=set-status][data-status=confirmed]")), "booking details open with Confirm button");
ok(!emojiIn(w.document.body.innerHTML), "no emoji in the admin bookings list or booking details", emojiIn(w.document.body.innerHTML));
$("[data-action=set-status][data-status=confirmed]").click();
ok(await until(async () => (await dbq(`select status from public.bookings where guest_email='ben@example.com'`))[0].status === "confirmed"), "Confirm → database updated");
ok(await until(() => $("[data-action=record-pay]")), "after confirming, 'record payment' is offered");
$("#pay-method").value = "upi";
$("[data-action=record-pay]").click();
ok(await until(async () => /DS\/\d\d-\d\d\/0002/.test((await dbq(`select invoice_no from public.bookings where guest_email='ben@example.com'`))[0].invoice_no || "")), "recording UPI payment issues invoice 0002");
await until(() => $("#notes"));
$("#notes").value = "Arriving late, ~9pm";
$("[data-action=save-notes]").click();
ok(await until(async () => (await dbq(`select admin_notes from public.bookings where guest_email='ben@example.com'`))[0].admin_notes === "Arriving late, ~9pm"), "private notes saved");
ok(!$("[data-action=delete]"), "paid booking has no delete option");
$("[data-action=dlg-close]").click();

// manual booking + CSV injection
$("[data-action=new-booking]").click();
await until(() => $("#f-manual"));
const mf = $("#f-manual");
fld(mf, "room").value = "garden-room"; fld(mf, "ci").value = day(mon + 10); fld(mf, "co").value = day(mon + 12); fld(mf, "name").value = "=HYPERLINK(\"http://evil\")"; fld(mf, "phone").value = "+91 90000 99999";
mf.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
ok(await until(async () => (await dbq(`select status, source from public.bookings where guest_phone='+91 90000 99999'`))[0]?.status === "confirmed"), "admin adds a phone booking (confirmed, blocks dates)");
$("[data-action=dlg-close]").click();
w.document.querySelector("[data-chip=all]").click();
$("[data-action=export]").click();
const csv = await new Promise((r) => { const fr = new w.FileReader(); fr.onload = () => r(fr.result); fr.readAsText(w.__lastBlob); });
ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`) && !/,=HYPERLINK/.test(csv), "CSV export neutralises spreadsheet formulas");

// rooms
w.document.querySelector("[data-tab=rooms]").click();
const form = await until(() => w.document.querySelector("form.room-edit[data-room='garden-room']"));
fld(form, "price_per_night").value = "3200";
form.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
ok(await until(async () => (await dbq(`select price_per_night from public.rooms where id='garden-room'`))[0].price_per_night === 3200), "room price edited from admin");
$("[data-action=add-room]").click();
const nf = await until(() => w.document.querySelector("form.room-edit[data-new='1']"));
fld(nf, "name").value = "Tree House"; fld(nf, "price_per_night").value = "5000"; fld(nf, "features").value = "Canopy views\nOutdoor shower";
nf.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
ok(await until(async () => (await dbq(`select features from public.rooms where id='tree-house'`))[0]?.features?.length === 2), "new room created with ID tree-house");
const tf = await until(() => w.document.querySelector("form.room-edit[data-room='tree-house']"));
const pick = (form, files) => {
  const inp = form.querySelector("[data-media-input]");
  Object.defineProperty(inp, "files", { value: files, configurable: true });
  inp.dispatchEvent(new w.Event("change", { bubbles: true }));
};
const photo = new w.File([new Uint8Array([0xff, 0xd8, 0xff])], "tree.jpg", { type: "image/jpeg" });
const clip = new w.File([new Uint8Array([0, 0, 0, 0x18])], "walk.mp4", { type: "video/mp4" });
const deck = new w.File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "deck.jpg", { type: "image/jpeg" });
pick(tf, [clip, photo, deck]);
ok(tf.querySelectorAll(".media-item").length === 3 && (tf.querySelector(".media").textContent.match(/not uploaded yet/g) || []).length === 3, "chosen video + 2 photos are listed, not uploaded until Save");
tf.querySelector("[data-action=media-cover][data-i='1']").click();
ok(/Photo/.test(tf.querySelector(".media-item .media-meta").textContent) && tf.querySelector(".media-item .media-cover"), "“Make cover” moves the photo to the front");
tf.querySelector("[data-action=media-move][data-i='1'][data-d='1']").click();
ok([...tf.querySelectorAll(".media-item .media-meta")].map((x) => /Video/.test(x.textContent) ? "v" : "p").join("") === "ppv", "arrows re-arrange the order (video moved last)");
const huge = new w.File([new Uint8Array(1)], "long.mp4", { type: "video/mp4" });
Object.defineProperty(huge, "size", { value: 501 * 1048576 });
pick(tf, [huge]);
ok(/over 500 MB/.test(tf.querySelector("[data-msg]").textContent) && tf.querySelectorAll(".media-item").length === 3, "a video that would take the stay over 500 MB is refused");
const bigPhoto = new w.File([new Uint8Array(1)], "raw.jpg", { type: "image/jpeg" });
Object.defineProperty(bigPhoto, "size", { value: 21 * 1048576 });
pick(tf, [bigPhoto, new w.File(["%PDF"], "menu.pdf", { type: "application/pdf" })]);
ok(/up to 20 MB/.test(tf.querySelector("[data-msg]").textContent) && /JPEG, PNG or WebP/.test(tf.querySelector("[data-msg]").textContent) && tf.querySelectorAll(".media-item").length === 3, "photos over 20 MB and other file types are refused");
tf.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
const treeRow = async () => (await dbq(`select media, image_url from public.rooms where id='tree-house'`))[0];
ok(await until(async () => { const r = await treeRow(); return r.media.length === 3 && r.media.map((m) => m.type).join() === "image,image,video" && /room-images\/tree-house-[a-z0-9]+\.jpg$/.test(r.image_url || "") && r.image_url === r.media[0].url && r.media[0].size === 3; }),
  "uploaded on Save and stored in the chosen order; cover photo = first", JSON.stringify(await treeRow()));
const tf2 = await until(() => { const f = w.document.querySelector("form.room-edit[data-room='tree-house']"); return f && f !== tf && f; });
const deckPath = (await treeRow()).media[1].path;
tf2.querySelector("[data-action=media-remove][data-i='1']").click();
ok(/1 to delete when you save/.test(tf2.querySelector("[data-media-used]").textContent) && !deletedFiles.includes(deckPath), "a removed photo is only deleted when you save");
tf2.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
ok(await until(async () => (await treeRow()).media.length === 2 && deletedFiles.includes(deckPath)), "after Save the photo is gone from the room and its file deleted from storage");
ok(!emojiIn(w.document.querySelector("#rooms-list").innerHTML) && w.document.querySelector("#rooms-list .media-badge svg"), "no emoji in the admin rooms tab (video badge is a drawn icon)", emojiIn(w.document.querySelector("#rooms-list").innerHTML));

// settings
w.document.querySelector("[data-tab=settings]").click();
const sf = await until(() => { const f = $("#f-settings"); return fld(f, "business_legal_name").value ? f : null; });
fld(sf, "gst_enabled").checked = true; fld(sf, "gstin").value = "";
sf.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
ok(await until(() => /Enter your GSTIN/.test($("#settings-msg").textContent)), "GST on without GSTIN is refused");
fld(sf, "gstin").value = "33abcde1234f1z5"; fld(sf, "business_legal_name").value = "Test Stays Pvt Ltd";
sf.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
ok(await until(async () => (await dbq(`select gst_enabled, gstin from public.settings`))[0].gstin === "33ABCDE1234F1Z5"), "GST settings saved (GSTIN upper-cased)");
const q = (await dbq(`select public.compute_quote('garden-room', $1, $2, 1) q`, [day(mon + 20), day(mon + 21)]))[0].q;
ok(q.gst_paise === 16000 && q.gstin === "33ABCDE1234F1Z5", "next quote includes 5% GST on ₹3,200");
ok(/TAX INVOICE/.test(w.Stay.invoiceHTML({ ...q, quote: q, ref: "BK-1", room_name: "Garden Room", num_units: 1, check_in: q.check_in, check_out: q.check_out, payment_status: "paid", invoice_no: "INV/26-27/0009", subtotal_paise: q.subtotal_paise, total_paise: q.total_paise })) , "with GST on, paid bookings print as TAX INVOICE with CGST/SGST");

// contact details are managed from the admin
fld(sf, "contact_phones").value = "+91 90000 55555\nnot a phone";
sf.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
ok(await until(() => /isn't a valid phone number/.test($("#settings-msg").textContent)), "invalid contact phone refused in admin");
fld(sf, "contact_phones").value = "+91 90000 55555";
fld(sf, "contact_address").value = "New Office Road\nAuroville";
sf.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
ok(await until(async () => { const r = (await dbq(`select contact_phones, contact_address from public.settings`))[0]; return r.contact_phones[0] === "+91 90000 55555" && r.contact_address[0] === "New Office Road"; }), "admin saves new contact phone + address");

// a second location
w.document.querySelector("[data-tab=locations]").click();
ok(await until(() => w.document.querySelector("form.loc-edit[data-loc='auroville']")), "Locations tab lists Auroville");
$("[data-action=add-location]").click();
const lf = await until(() => w.document.querySelector("form.loc-edit[data-new='1']"));
fld(lf, "name").value = "Kodaikanal"; fld(lf, "area_label").value = "Palani Hills"; fld(lf, "state").value = "Tamil Nadu"; fld(lf, "gstin").value = "29ABCDE1234F1Z5";
lf.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
ok(await until(() => /must start with 33/.test(lf.querySelector("[data-msg]").textContent)), "GSTIN from the wrong state is refused for a location");
fld(lf, "gstin").value = "";
lf.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
ok(await until(async () => (await dbq(`select state from public.locations where id='kodaikanal'`))[0]?.state === "Tamil Nadu"), "admin creates the Kodaikanal location");
w.document.querySelector("[data-tab=rooms]").click();
const trf = await until(() => w.document.querySelector("form.room-edit[data-room='tree-house'] select[name=location_id] option[value='kodaikanal']") && w.document.querySelector("form.room-edit[data-room='tree-house']"));
fld(trf, "location_id").value = "kodaikanal";
trf.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
ok(await until(async () => (await dbq(`select location_id from public.rooms where id='tree-house'`))[0].location_id === "kodaikanal"), "room moved to Kodaikanal");

// what guests now see
const site = await openPage("index.html");
const sq = (x) => site.document.querySelector(x);
ok(await until(() => /\+91 90000 55555/.test(sq("#contact-grid").textContent) && /New Office Road/.test(sq("#contact-grid").textContent)), "website shows the contact details the admin just saved");
ok(await until(() => site.document.querySelectorAll("#loc-tabs .loc-tab").length === 3), "two locations → location tabs (All · Auroville · Kodaikanal)");
[...site.document.querySelectorAll("#loc-tabs .loc-tab")].find((b) => /Kodaikanal/.test(b.textContent)).click();
ok(site.document.querySelectorAll("#rooms .room-card").length === 1 && /Tree House/.test(sq("#rooms").textContent) && /Palani Hills/.test(sq("#loc-intro").textContent), "Kodaikanal tab shows only its stay + location intro");
ok(/Kodaikanal/.test(sq("#rooms .room-loc")?.textContent || ""), "room cards show their location");
sq(".hero [data-action=book]").click();
ok(await until(() => !sq("#booking").hidden && sq("#bk-rooms .room-chosen") && /Tree House/.test(sq("#bk-rooms").textContent)), "place with one stay chosen on the page → “Reserve” opens on that stay");
sq("[data-action=close]").click();
sq("#loc-tabs .loc-tab[data-loc='auroville']").click();
sq(".hero [data-action=book]").click();
ok(await until(() => !sq("#booking").hidden && site.document.querySelectorAll("#bk-rooms .room-option").length === 2 && !/Tree House/.test(sq("#bk-rooms").textContent)), "place with two stays chosen → dialog lists only that place's rooms");
sq("[data-action=room-all]").click();
ok(site.document.querySelectorAll("#bk-rooms .room-option").length === 3, "“Show all rooms” → every room");
sq("[data-action=close]").click();
sq("#loc-tabs .loc-tab[data-loc='kodaikanal']").click();
typePlace(site, "palani hills");
ok(site.document.querySelectorAll("#loc-tabs .loc-tab").length === 1 && /Kodaikanal/.test(sq("#loc-tabs").textContent) && site.document.querySelectorAll("#rooms .room-card").length === 1 && /1 stay in Kodaikanal/.test(sq("#loc-status").textContent), "search “palani hills” → only Kodaikanal and its stay");
typePlace(site, "KODAIKÁNAL");
ok(site.document.querySelectorAll("#rooms .room-card").length === 1 && /Tree House/.test(sq("#rooms").textContent), "search ignores capitals and accents (“KODAIKÁNAL”)");
typePlace(site, "tamil nadu");
ok(site.document.querySelectorAll("#loc-tabs .loc-tab").length === 3 && /All matches/.test(sq("#loc-tabs").textContent) && sq("#loc-tabs .loc-tab.active")?.dataset.loc === "kodaikanal", "search matching both places → both buttons + “All matches”, chosen place kept");
sq("#loc-tabs .loc-tab[data-loc='']").click();
ok(site.document.querySelectorAll("#rooms .room-card").length === 3 && /3 stays in 2 places/.test(sq("#loc-status").textContent), "“All matches” → every stay in both places", sq("#loc-status").textContent);
sq(".loc-clear").click();
ok(sq("#loc-q").value === "" && /All stays/.test(sq("#loc-tabs").textContent), "clear button empties the search");
setWeekend(site, "special");
const chipCount = (loc) => sq(`#loc-tabs .loc-tab[data-loc='${loc}'] span`)?.textContent;
ok(chipCount("") === "1" && chipCount("auroville") === "1" && chipCount("kodaikanal") === "0" && cardNames(site) === "Garden Room", "location counts follow the filters (only Garden Room has a weekend rate)", `${chipCount("")}/${chipCount("auroville")}/${chipCount("kodaikanal")} ${cardNames(site)}`);
setWeekend(site, "same");
ok(cardNames(site) === "Tree House" && chipCount("kodaikanal") === "1", "“Same price every day” → Tree House", cardNames(site));
site.document.querySelector(".sf-clear").click();
const tcard = await until(() => site.document.querySelector("[data-action=gallery][data-room='tree-house']"));
ok(tcard && /1 photo · 1 video/.test(tcard.textContent) && tcard.querySelector("img"), "room card: cover photo + “1 photo · 1 video”");
ok(!site.document.querySelector("[data-action=gallery][data-room='cottage']"), "a room without photos keeps the placeholder (no gallery)");
tcard.click();
ok(!sq("#gallery").hidden && sq("#gl-stage img") && /1 \/ 2/.test(sq("#gl-count").textContent) && /Tree House/.test(sq("#gl-title").textContent), "gallery opens on the first item");
sq("[data-action=gallery-next]").click();
ok(sq("#gl-stage video[controls]") && /2 \/ 2/.test(sq("#gl-count").textContent), "next → the video, with play controls");
site.document.dispatchEvent(new site.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
ok(/1 \/ 2/.test(sq("#gl-count").textContent) && sq("#gl-stage img"), "arrow keys move through the gallery (and wrap around)");
sq("#gl-book").click();
ok(await until(() => sq("#gallery").hidden && !sq("#booking").hidden && /Tree House/.test(sq("#bk-rooms").textContent)), "“Book this room” in the gallery opens booking on that room");
sq("[data-action=close]").click();
sq("[data-action=book]").click();
ok(await until(() => site.document.querySelectorAll("#bk-rooms .ro-group").length === 2), "booking form groups rooms by location");
const ld = JSON.parse(site.document.querySelector("script[type='application/ld+json']").textContent);
ok(ld["@graph"].filter((n) => n["@type"] === "LodgingBusiness").length === 2 && ld["@graph"][0]["@type"] === "Organization", "search-engine data: Dhyana Stays + one lodging per location");

// session expiry handling
for (const k of tokens.keys()) tokens.delete(k);
w.sessionStorage.setItem("stay_admin_session", JSON.stringify({ access_token: "dead", refresh_token: "r-nobody", expires_at: 0 }));
w = await openPage("admin.html");
$ = (s) => w.document.querySelector(s);
ok(await until(() => !$("#auth").hidden), "expired session falls back to the login screen");

const realErrors = errors.filter((e) => !/Could not load (link|script)|stylesheet/.test(e));
ok(realErrors.length === 0, "no JavaScript errors in either page", JSON.stringify(realErrors.slice(0, 5)));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
