// End-to-end test of supabase/functions/booking-api/index.ts:
// real function code (Node type-stripping) → mocked PostgREST backed by PGlite running setup.sql.
// usage: node fn.test.mjs <pgdeps> <setup.sql> <index.ts>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
import path from "node:path";

const [deps, sqlPath, fnPath] = process.argv.slice(2);
const pg = await import(pathToFileURL(path.join(deps, "node_modules/@electric-sql/pglite/dist/index.js")).href);
const { btree_gist } = await import(pathToFileURL(path.join(deps, "node_modules/@electric-sql/pglite/dist/contrib/btree_gist.js")).href);
const db = new pg.PGlite({ extensions: { btree_gist } });
const fatal = (e) => { console.log("FATAL:", e?.message, e?.where || "", e?.stack?.split("\n").slice(0, 4).join(" | ")); process.exit(1); };
process.on("uncaughtException", fatal); process.on("unhandledRejection", fatal);

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema extensions; create schema auth; create schema storage;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`);
await db.exec(readFileSync(sqlPath, "utf8"));

let pass = 0, fail = 0;
const ok = (c, name, extra = "") => { if (c) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name, extra); } };

// ---- environment for the function ------------------------------------
const ENV = {
  SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key-abcdefghijklmnopqrstuvwxyz",
  RAZORPAY_KEY_ID: "rzp_test_KEY", RAZORPAY_KEY_SECRET: "rzp_secret_123", RAZORPAY_WEBHOOK_SECRET: "whsec_456",
  ALLOWED_ORIGINS: "https://www.example-stay.com", IP_HASH_SALT: "salt", RESEND_API_KEY: "re_x",
  EMAIL_FROM: "Stay <hello@example-stay.com>", OWNER_EMAIL: "owner@example-stay.com", SITE_NAME: "Example Stay",
  SITE_URL: "https://www.example-stay.com",
};
let handler;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
const bg = [];
globalThis.EdgeRuntime = { waitUntil: (p) => bg.push(p) };
const flush = async () => { await Promise.all(bg.splice(0)); };

// ---- mocked network --------------------------------------------------
const emails = []; let orderSeq = 0; let razorpayDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const h = new Headers(init.headers);
  if (url.startsWith(ENV.SUPABASE_URL + "/rest/v1/rpc/")) {
    if (h.get("apikey") !== ENV.SUPABASE_SERVICE_ROLE_KEY) return new Response('{"message":"bad key"}', { status: 401 });
    const fn = url.split("/").pop();
    const args = JSON.parse(init.body || "{}");
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
    try {
      await db.exec("reset role; set role service_role;");
      const res = await db.query(sql, keys.map((k) => args[k]));
      await db.exec("reset role;");
      const r = res.rows[0]?.r;
      return new Response(r === undefined || r === null || r === "" ? "" : JSON.stringify(r), { status: 200 });
    } catch (e) {
      await db.exec("reset role;");
      return new Response(JSON.stringify({ code: e.code, message: e.message }), { status: 400 });
    }
  }
  if (url.startsWith(ENV.SUPABASE_URL + "/rest/v1/settings?")) {
    if (h.get("apikey") !== ENV.SUPABASE_SERVICE_ROLE_KEY) return new Response("[]", { status: 401 });
    const r = await db.query(`select contact_phones, contact_emails from public.settings`);
    return new Response(JSON.stringify(r.rows), { status: 200 });
  }
  if (url === "https://api.razorpay.com/v1/orders") {
    if (razorpayDown) return new Response('{"error":{"description":"down"}}', { status: 502 });
    const auth = h.get("authorization");
    if (auth !== "Basic " + Buffer.from(`${ENV.RAZORPAY_KEY_ID}:${ENV.RAZORPAY_KEY_SECRET}`).toString("base64")) return new Response("{}", { status: 401 });
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: "order_T" + (++orderSeq), amount: body.amount, currency: body.currency, receipt: body.receipt }), { status: 200 });
  }
  if (url === "https://api.resend.com/emails") { emails.push(JSON.parse(init.body)); return new Response('{"id":"e"}', { status: 200 }); }
  return realFetch(url, init);
};

await import(pathToFileURL(fnPath).href);
ok(typeof handler === "function", "function file loads and registers Deno.serve");

const ORIGIN = ENV.ALLOWED_ORIGINS;
const call = async (route, body, { origin = ORIGIN, headers = {}, raw } = {}) => {
  const res = await handler(new Request(`${ENV.SUPABASE_URL}/functions/v1/booking-api/${route}`, {
    method: "POST", headers: { "content-type": "application/json", origin, "x-forwarded-for": "203.0.113.9", ...headers },
    body: raw ?? JSON.stringify(body),
  }));
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
};
const sign = (secret, msg) => createHmac("sha256", secret).update(msg).digest("hex");
const bookingRow = async (id) => (await db.query(`select * from public.bookings where id = $1`, [id])).rows[0];

const today = (await db.query(`select public.local_today()::text d`)).rows[0].d;
const day = (n) => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let mon = 14; while (new Date(day(mon) + "T00:00:00Z").getUTCDay() !== 1) mon++;
const guest = (o = {}) => ({ room_id: "garden-room", check_in: day(mon), check_out: day(mon + 2), units: 1, guests: 2, mode: "online",
  name: "Asha Rao", email: "asha@example.com", phone: "+91 98765 43210", requests: "", company: "", ...o });

console.log("http basics");
const pre = await handler(new Request(`${ENV.SUPABASE_URL}/functions/v1/booking-api/create`, { method: "OPTIONS", headers: { origin: ORIGIN } }));
ok(pre.status === 204 && pre.headers.get("access-control-allow-origin") === ORIGIN, "CORS preflight allows the site's origin");
ok((await call("create", guest(), { origin: "https://evil.example" })).status === 403, "other websites are refused");
ok((await call("nope", {})).status === 404, "unknown route → 404");
ok((await call("create", null, { raw: "not json" })).status === 400, "malformed JSON → 400");
ok((await call("create", null, { raw: JSON.stringify({ x: "y".repeat(20000) }) })).status === 413, "oversized body → 413");

console.log("create");
const c1 = await call("create", { ...guest(), amount: 100, total_paise: 100 });
ok(c1.status === 200 && c1.data.payment?.order_id && c1.data.payment.amount === 600000, "online booking: Razorpay order uses the SERVER price (client's ₹1 ignored)", JSON.stringify(c1.data).slice(0, 300));
ok(c1.data.payment.key_id === ENV.RAZORPAY_KEY_ID && !JSON.stringify(c1.data).includes(ENV.RAZORPAY_KEY_SECRET), "returns the public key id, never the secret");
ok(c1.data.booking.status === "hold" && !("client_ip_hash" in c1.data.booking) && !("admin_notes" in c1.data.booking), "guest sees their hold, not internal fields");
ok((await bookingRow(c1.data.booking.id)).client_ip_hash?.length === 32, "device is recorded as a salted hash, not a raw IP");
ok((await call("create", guest({ company: "Acme" }))).status === 400, "honeypot field filled → rejected");
const badEmail = await call("create", guest({ email: "nope" }));
ok(badEmail.status === 422 && badEmail.data.error === "invalid_details", "invalid email → 422 invalid_details");
const pastDate = await call("create", guest({ check_in: day(-2), check_out: day(-1) }));
ok(pastDate.data.error === "date_in_past", "past dates refused with a clear code");
ok((await call("create", guest({ units: "1" }))).status === 400, "wrong types refused");
ok((await call("create", guest({ mode: "free" }))).data.error === "invalid_mode", "unknown payment mode refused");

console.log("verify (browser after payment)");
const orderId = c1.data.payment.order_id, payId = "pay_ABC123";
const bad = await call("verify", { razorpay_order_id: orderId, razorpay_payment_id: payId, razorpay_signature: "0".repeat(64) });
ok(bad.status === 400 && bad.data.error === "invalid_signature", "forged signature refused");
ok((await bookingRow(c1.data.booking.id)).status === "hold", "…and the booking stays unconfirmed");
const good = await call("verify", { razorpay_order_id: orderId, razorpay_payment_id: payId, razorpay_signature: sign(ENV.RAZORPAY_KEY_SECRET, `${orderId}|${payId}`) });
ok(good.status === 200 && good.data.booking.status === "confirmed" && good.data.booking.payment_status === "paid", "genuine signature confirms and marks paid");
ok(/^DS\/\d\d-\d\d\/0001$/.test(good.data.booking.invoice_no), "invoice number returned to guest", good.data.booking.invoice_no);
await flush();
ok(emails.length === 2 && emails.some((e) => e.to[0] === ENV.OWNER_EMAIL) && emails.some((e) => e.to[0] === "asha@example.com"), "owner + guest emailed once", JSON.stringify(emails.map((e) => e.to)));
const guestMail = emails.find((e) => e.to[0] === "asha@example.com");
ok(guestMail && guestMail.html.includes("+91 98400 36900") && guestMail.html.includes("support@dhyanastays.com"), "guest email ends with the contact details from admin settings");
ok(guestMail && guestMail.html.includes("Garden Room — Auroville") && good.data.booking.location_name === "Auroville", "email + confirmation name the location");

console.log("webhook (Razorpay → server)");
const evt = (oid, pid, amount) => JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: pid, order_id: oid, amount, status: "captured" } } } });
const raw1 = evt(orderId, payId, 600000);
ok((await call("webhook", null, { raw: raw1, headers: { "x-razorpay-signature": "bad" }, origin: "" })).status === 400, "webhook with bad signature refused");
const w1 = await call("webhook", null, { raw: raw1, headers: { "x-razorpay-signature": sign(ENV.RAZORPAY_WEBHOOK_SECRET, raw1) }, origin: "" });
await flush();
ok(w1.status === 200 && emails.length === 2, "duplicate confirmation via webhook is harmless (no second email)");
// guest closes the tab right after paying: only the webhook arrives
const c2 = await call("create", guest({ check_in: day(mon + 7), check_out: day(mon + 8), email: "ben@example.com", phone: "+91 90000 11111" }));
const raw2 = evt(c2.data.payment.order_id, "pay_TABCLOSED", c2.data.payment.amount);
const w2 = await call("webhook", null, { raw: raw2, headers: { "x-razorpay-signature": sign(ENV.RAZORPAY_WEBHOOK_SECRET, raw2) }, origin: "" });
const r2 = await bookingRow(c2.data.booking.id);
ok(w2.status === 200 && r2.status === "confirmed" && r2.invoice_no, "closed tab after paying → webhook still confirms the booking");
const raw3 = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_X", order_id: "order_OTHER", amount: 100 } } } });
ok((await call("webhook", null, { raw: raw3, headers: { "x-razorpay-signature": sign(ENV.RAZORPAY_WEBHOOK_SECRET, raw3) }, origin: "" })).status === 200, "payments for unknown orders are acknowledged and ignored");

console.log("pay on arrival / availability / failures");
emails.length = 0;
const a1 = await call("create", guest({ mode: "arrival", check_in: day(mon), check_out: day(mon + 2), email: "cy@example.com", phone: "+91 90000 22222", name: "<script>alert(1)</script>" }));
await flush();
ok(a1.status === 200 && a1.data.booking.status === "hold" && !a1.data.payment, "pay-on-arrival → 24h hold, no payment step");
const ownerMail = emails.find((e) => e.to[0] === ENV.OWNER_EMAIL);
ok(ownerMail && /Action needed/.test(ownerMail.subject), "owner gets an 'Action needed: confirm' email");
ok(ownerMail && ownerMail.html.includes("&lt;script&gt;") && !ownerMail.html.includes("<script>"), "guest-typed HTML is escaped in emails");
const full = await call("create", guest({ mode: "arrival", email: "dee@example.com", phone: "+91 90000 33333" }));
ok(full.status === 409 && full.data.error === "not_available", "fully-booked dates → 409 not_available");
razorpayDown = true;
const down = await call("create", guest({ check_in: day(mon + 30), check_out: day(mon + 31), email: "eve@example.com", phone: "+91 90000 44444" }));
razorpayDown = false;
const freed = (await db.query(`select status from public.bookings where guest_email = 'eve@example.com'`)).rows[0];
ok(down.status === 500 && freed.status === "expired", "if Razorpay is down the hold is released immediately");
const inq = await call("create", guest({ room_id: "cottage", email: "fay@example.com", phone: "+91 90000 55555" }));
ok(inq.status === 200 && inq.data.booking.status === "inquiry" && !inq.data.payment, "unpriced room → inquiry (no payment, no hold)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
