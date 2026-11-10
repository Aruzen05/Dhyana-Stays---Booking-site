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

async function storage(url, init, headers) {
  const [role, sub] = who(headers);
  const name = new URL(url).pathname.replace("/storage/v1/object/room-images/", "");
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
ok(await until(() => /\+91 98400 36900/.test($("#contact-grid").textContent) && /support@dhyanastays\.com/.test($("#contact-grid").textContent) && /ECR Road, Auroville/.test($("#footer-line").textContent)), "contact details come from the database (admin settings), not config.js");
ok(!$("#loc-tabs").textContent.trim() && /Auroville/.test($("#loc-intro").textContent), "one location → no tabs, location intro shown");

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
ok(rzpOpts?.amount === 600000 && rzpOpts.prefill.email === "asha@example.com", "Razorpay opened with the server amount and guest prefill");
ok(/DS\/\d\d-\d\d\/0001/.test($("#bk-done").textContent), "invoice number shown to guest");
ok($("[data-action=download]")?.textContent.includes("invoice"), "invoice download offered");
const inv = w.Stay.invoiceHTML((await dbq(`select to_jsonb(b) j from public.bookings b where guest_email = 'asha@example.com'`))[0].j);
ok(/PAYMENT RECEIPT/.test(inv) && /DS\/\d\d-\d\d\/0001/.test(inv) && /Supplier not registered under GST/.test(inv), "invoice: receipt (GST off), number, and no-GST note");
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
const file = new w.File([new Uint8Array([0xff, 0xd8, 0xff])], "tree.jpg", { type: "image/jpeg" });
Object.defineProperty(fld(tf, "photo"), "files", { value: [file] });
const origFD = w.FormData;
w.FormData = class extends origFD { get(k) { return k === "photo" ? file : super.get(k); } };
tf.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
ok(await until(async () => /room-images\/tree-house-\d+\.jpg$/.test((await dbq(`select image_url from public.rooms where id='tree-house'`))[0].image_url || "")), "photo uploaded to storage and linked to the room");
w.FormData = origFD;

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
