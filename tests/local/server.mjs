// LOCAL TEST SERVER: try the website and the owner dashboard on your own computer
// before anything is set up on Supabase.
//
//   cd tests
//   npm install          (first time only)
//   npm run local
//
//   Website:        http://localhost:8787
//   Owner login:    http://localhost:8787/admin.html   (sample login printed in the terminal)
//   Emails "sent":  http://localhost:8787/__local/emails
//
// What runs here is the real thing wherever possible: the real web/ pages, the real
// supabase/setup.sql (on PGlite, which is Postgres compiled to WebAssembly, in memory), and the
// real supabase/functions/booking-api code. Supabase's login, database API and photo storage
// are imitated in this file. Razorpay and email are fake: no money moves, no email leaves.
//
// Everything lives in memory and resets when you stop the server (Ctrl+C).
// Nothing in tests/ is deployed: Cloudflare publishes only web/, so the sample logins can
// never reach the live site.
import http from "node:http";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, appendFileSync, renameSync, unlinkSync, rmSync, createReadStream } from "node:fs";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

// ---------------------------------------------------------------------
//  Settings you might change
// ---------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 8787;
const OWNER = { email: "owner@example.com", password: "test-owner-123" };          // admin
const NOT_ADMIN = { email: "not-admin@example.com", password: "not-admin-123" };   // can sign in, but isn't an admin

// ---------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const WEB = path.join(ROOT, "web");
const NM = path.resolve(HERE, "..", "node_modules");
if (!existsSync(path.join(NM, "@electric-sql/pglite"))) {
  console.error("Missing test tools. Run this first, inside the tests folder:  npm install");
  process.exit(1);
}
const BASE = `http://localhost:${PORT}`;
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const ORIGINS = [...HOSTS].map((h) => `http://${h}`);

// Keys in the new Supabase format, so the site's handling of sb_ keys is exercised too.
const PUBLISHABLE = "sb_publishable_local_test_only";
const SERVICE = "sb_secret_local_" + randomBytes(16).toString("hex");
const RZP = { keyId: "rzp_test_LOCAL", secret: randomBytes(16).toString("hex"), webhookSecret: randomBytes(16).toString("hex") };

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

// ---------------------------------------------------------------------
//  Database: real setup.sql on PGlite, with stand-ins for Supabase's auth/storage schemas
// ---------------------------------------------------------------------
const pg = await import(pathToFileURL(path.join(NM, "@electric-sql/pglite/dist/index.js")).href);
const { btree_gist } = await import(pathToFileURL(path.join(NM, "@electric-sql/pglite/dist/contrib/btree_gist.js")).href);
const isoTs = (v) => v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
// Dates and timestamps come back as strings, the way PostgREST returns them.
const db = new pg.PGlite({ extensions: { btree_gist }, parsers: { 1082: (v) => v, 1114: (v) => v.replace(" ", "T"), 1184: isoTs } });

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema extensions; create schema auth; create schema storage;
  create table auth.users (id uuid primary key, email text unique, password text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
  grant all on storage.objects to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`);
await db.exec(readFileSync(path.join(ROOT, "supabase/setup.sql"), "utf8"));

// Local-only change: photos uploaded here live at http://localhost:<port>/storage/…, which the
// live rule (https:// or images/ only) would refuse. The real setup.sql is untouched.
await db.exec(`
  do $$ declare c text; begin
    select conname into c from pg_constraint
     where conrelid = 'public.rooms'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%image_url%';
    if c is not null then execute format('alter table public.rooms drop constraint %I', c); end if;
  end $$;
  alter table public.rooms add constraint rooms_image_url_check
    check (image_url is null or image_url ~ '^(https://|images/|http://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${PORT}/storage/v1/object/public/room-images/)');
`);

// Same for photos/videos in rooms.media.
await db.exec(`
  create or replace function public.media_url_ok(u text) returns boolean language sql immutable set search_path = '' as $f$
    select u ~ '^(https://|images/|http://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${PORT}/storage/v1/object/public/room-images/)[^\\s"''<>]+$'
  $f$;
`);

// One connection, many roles: queries that switch role are run one at a time.
let qlock = Promise.resolve();
function asRole(role, sub, fn) {
  const run = qlock.then(async () => {
    await db.query(`reset role`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub || ""]);
    if (role !== "postgres") await db.exec(`set role ${role}`);
    try { return await fn(); } finally { await db.exec("reset role"); }
  });
  qlock = run.catch(() => {});
  return run;
}
const sql = (text, params) => asRole("postgres", "", () => db.query(text, params)).then((r) => r.rows);

// ---------------------------------------------------------------------
//  Sample data: two logins and a few bookings, made through the real booking functions
// ---------------------------------------------------------------------
const ownerId = randomUUID(), notAdminId = randomUUID();
await sql(`insert into auth.users (id, email, password) values ($1, $2, $3), ($4, $5, $6)`,
  [ownerId, OWNER.email, OWNER.password, notAdminId, NOT_ADMIN.email, NOT_ADMIN.password]);
await sql(`insert into public.admins (user_id) values ($1)`, [ownerId]);

// A second sample place, so the location search and place buttons on the website have something to choose between.
await sql(`insert into public.locations (id, name, area_label, description, address_lines, city, state, sort_order)
  values ('kodaikanal-sample', 'Kodaikanal', 'Palani Hills', 'Sample second location for local testing: cool hill air and pine forests.',
          array['Lake Road'], 'Kodaikanal', 'Tamil Nadu', 2)`);
await sql(`insert into public.rooms (id, location_id, name, capacity_label, max_guests, description, features, price_per_night, weekend_price, max_units, image_url, sort_order)
  values ('hill-cabin-sample', 'kodaikanal-sample', 'Hill Cabin (sample)', '2 Adults', 2, 'A sample room in the sample second location.',
          array['Fireplace', 'Valley view'], 4500, 5000, 1, 'images/placeholder-room.svg', 3)`);

const today = (await sql(`select public.local_today()::text d`))[0].d;
const day = (n) => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let mon = 14; while (new Date(day(mon) + "T00:00:00Z").getUTCDay() !== 1) mon++;   // a Monday 2+ weeks ahead

async function seedBooking(room, ci, co, name, email, phone, requests, mode, ip) {
  return (await asRole("service_role", "", () => db.query(
    `select public.create_booking($1, $2, $3, 1, 2, $4, $5, $6, $7, $8, $9) as b`,
    [room, ci, co, name, email, phone, requests, mode, ip]))).rows[0].b;
}
const seeded = [];
try {
  const paid = await seedBooking("garden-room", day(mon), day(mon + 2), "Asha Rao (sample)", "asha@example.com", "+91 98765 43210", "Arriving late evening", "online", "seed-1");
  await asRole("service_role", "", () => db.query(`select public.set_razorpay_order($1, 'order_SAMPLE1')`, [paid.id]));
  await asRole("service_role", "", () => db.query(`select public.confirm_payment('order_SAMPLE1', 'pay_SAMPLE1', $1)`, [paid.total_paise]));
  seeded.push("paid online");
  await seedBooking("garden-room", day(mon + 7), day(mon + 9), "Ben Das (sample)", "ben@example.com", "+91 90000 11111", null, "arrival", "seed-2");
  seeded.push("pay on arrival, waiting for you to confirm");
  await seedBooking("cottage", day(mon + 14), day(mon + 16), "Chitra Iyer (sample)", "chitra@example.com", "+91 90000 22222", "Is the cottage free these dates?", "online", "seed-3");
  seeded.push("price-on-request inquiry");
} catch (e) {
  log("Note: could not add every sample booking:", e.message);
}

// ---------------------------------------------------------------------
//  Small helpers
// ---------------------------------------------------------------------
const J = (data, status = 200, extra = {}) =>
  new Response(data === undefined ? "" : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extra } });
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Object.assign(new Error(`bad name: ${s}`), { code: "PGRST100" }); return s; };
const escHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const parseJson = (text) => { try { return text ? JSON.parse(text) : {}; } catch { return null; } };

const accessTokens = new Map();    // token → user id
const refreshTokens = new Map();   // token → user id
const files = new Map();           // storage path → { type, file (on disk), size }
const outbox = [];                 // emails the site tried to send
const orders = new Map();          // fake Razorpay orders: id → { amount, currency }

// Which database role a request runs as, like Supabase's API gateway decides.
function who(headers) {
  const key = headers.get("apikey") || "";
  const bearer = (headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (key === SERVICE) return ["service_role", ""];
  if (key !== PUBLISHABLE) return ["badkey", ""];
  if (!bearer || bearer === PUBLISHABLE) return ["anon", ""];
  if (accessTokens.has(bearer)) return ["authenticated", accessTokens.get(bearer)];
  return ["badjwt", ""];
}
function denied(role) {
  if (role === "badkey") return J({ message: "Invalid API key", hint: "Use the publishable key from config.js" }, 401);
  if (role === "badjwt") return J({ code: "PGRST301", message: "JWT expired" }, 401);
  return null;
}

// ---------------------------------------------------------------------
//  Database API (the parts of PostgREST the site uses)
// ---------------------------------------------------------------------
async function postgrest(url, method, headers, bodyText) {
  const [role, sub] = who(headers);
  const stop = denied(role); if (stop) return stop;
  const u = new URL(url);
  const parts = u.pathname.replace(/^\/rest\/v1\//, "").split("/");
  const body = parseJson(bodyText);
  if (body === null) return J({ code: "PGRST102", message: "Invalid JSON body" }, 400);
  try {
    if (parts[0] === "rpc") {
      if (method !== "POST") return J({ message: "Use POST for rpc" }, 405);
      const fn = ident(parts[1]); const keys = Object.keys(body);
      const res = await asRole(role, sub, () => db.query(
        `select * from public.${fn}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")})`, keys.map((k) => body[k])));
      if (res.fields.length === 1 && res.fields[0].name === fn) {
        const v = res.rows[0]?.[fn];
        return v === null || v === undefined || v === "" ? new Response("", { status: 200 }) : J(v);
      }
      return J(res.rows);
    }
    const table = ident(parts[0]);
    const where = [], params = [];
    let select = "*", order = "", limit = "", offset = "";
    for (const [k, v] of u.searchParams) {
      if (k === "select") select = v === "*" ? "*" : v.split(",").map(ident).join(",");
      else if (k === "order") order = " order by " + v.split(",").map((o) => { const [c, d] = o.split("."); return `${ident(c)} ${d === "desc" ? "desc" : "asc"}`; }).join(",");
      else if (k === "limit") limit = ` limit ${Math.max(0, Number(v) | 0)}`;
      else if (k === "offset") offset = ` offset ${Math.max(0, Number(v) | 0)}`;
      else {
        const m = /^eq\.(.*)$/.exec(v);
        if (!m) return J({ code: "PGRST100", message: `This local server only understands eq. filters (got ${k}=${v})` }, 400);
        params.push(m[1]); where.push(`${ident(k)}::text = $${params.length}`);
      }
    }
    const w = where.length ? " where " + where.join(" and ") : "";
    let text;
    if (method === "GET") text = `select ${select} from public.${table}${w}${order}${limit}${offset}`;
    else if (method === "PATCH") {
      const keys = Object.keys(body).map(ident);
      params.push(JSON.stringify(body));
      text = `update public.${table} t set ${keys.map((k) => `${k} = (x.r).${k}`).join(", ")} from (select json_populate_record(null::public.${table}, $${params.length}::json) r) x${w.replace(/(\w+)::text/g, "t.$1::text")} returning t.*`;
    } else if (method === "POST") {
      const keys = Object.keys(body).map(ident);
      params.push(JSON.stringify(body));
      text = `insert into public.${table} (${keys.join(",")}) select ${keys.map((k) => `(r).${k}`).join(",")} from (select json_populate_record(null::public.${table}, $${params.length}::json) r) x returning *`;
    } else if (method === "DELETE") text = `delete from public.${table}${w} returning *`;
    else return J({ message: "Method not allowed" }, 405);
    const res = await asRole(role, sub, () => db.query(text, params));
    return J(res.rows, method === "POST" ? 201 : 200);
  } catch (e) {
    return J({ code: e.code, message: e.message, details: e.detail || null, hint: e.hint || null }, e.code === "42501" ? 403 : 400);
  }
}

// ---------------------------------------------------------------------
//  Login (the parts of Supabase Auth the admin page uses)
// ---------------------------------------------------------------------
async function issueSession(userId) {
  const [user] = await sql(`select id, email from auth.users where id = $1`, [userId]);
  const access = "local-at-" + randomBytes(24).toString("hex"), refresh = "local-rt-" + randomBytes(24).toString("hex");
  accessTokens.set(access, user.id); refreshTokens.set(refresh, user.id);
  return { access_token: access, refresh_token: refresh, token_type: "bearer", expires_in: 3600,
           expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: user.id, email: user.email } };
}
async function gotrue(url, method, headers, bodyText) {
  if (headers.get("apikey") !== PUBLISHABLE) return J({ message: "Invalid API key" }, 401);
  const u = new URL(url); const p = u.pathname.replace(/^\/auth\/v1\//, "");
  const body = parseJson(bodyText) || {};
  const bearer = (headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const userId = accessTokens.get(bearer);

  if (p === "token" && u.searchParams.get("grant_type") === "password") {
    const [row] = await sql(`select id from auth.users where email = lower($1) and password = $2`, [String(body.email || ""), String(body.password || "")]);
    if (!row) { log("login refused:", String(body.email || "")); return J({ code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400); }
    log("signed in:", String(body.email));
    return J(await issueSession(row.id));
  }
  if (p === "token" && u.searchParams.get("grant_type") === "refresh_token") {
    const id = refreshTokens.get(String(body.refresh_token || ""));
    if (!id) return J({ code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" }, 400);
    refreshTokens.delete(String(body.refresh_token));
    return J(await issueSession(id));
  }
  if (p === "user" && method === "GET") {
    if (!userId) return J({ code: 401, error_code: "bad_jwt", msg: "JWT expired" }, 401);
    const [user] = await sql(`select id, email from auth.users where id = $1`, [userId]);
    return J({ id: user.id, email: user.email });
  }
  if (p === "user" && method === "PUT") {
    if (!userId) return J({ code: 401, error_code: "bad_jwt", msg: "JWT expired" }, 401);
    if (typeof body.password !== "string" || body.password.length < 10)
      return J({ code: 422, error_code: "weak_password", msg: "Password should be at least 10 characters." }, 422);
    await sql(`update auth.users set password = $1 where id = $2`, [body.password, userId]);
    log("password changed for", (await sql(`select email from auth.users where id = $1`, [userId]))[0].email, "(until the server stops)");
    return J({ id: userId });
  }
  if (p === "logout" && method === "POST") { accessTokens.delete(bearer); return new Response(null, { status: 204 }); }
  if (p === "recover" && method === "POST") {
    // Like Supabase: always "OK", but only real users get a link, and only to an allowed address.
    const [row] = await sql(`select id, email from auth.users where email = lower($1)`, [String(body.email || "")]);
    if (row) {
      const back = u.searchParams.get("redirect_to") || "";
      const target = ORIGINS.some((o) => back.startsWith(o + "/")) ? back.split("#")[0] : `${BASE}/admin.html`;
      const s = await issueSession(row.id);
      const link = `${target}#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&expires_at=${s.expires_at}&token_type=bearer&type=recovery`;
      addEmail({ to: [row.email], subject: "Reset your password", html: `<p>Someone asked to reset the password for ${escHtml(row.email)}.</p><p><a href="${escHtml(link)}" target="_top">Set a new password</a></p><p>Local test mode: on the live site Supabase sends this email.</p>` });
    }
    return J({});
  }
  return J({ code: 404, msg: "Not available in local test mode" }, 404);
}

// ---------------------------------------------------------------------
//  Photo & video storage (room-images bucket), with the bucket's own rules from setup.sql.
//  Files are kept in a temporary folder that's deleted when the server stops.
//  LOCAL_MAX_FILE_MB=50 imitates the Supabase Free plan's 50 MB-per-file limit.
// ---------------------------------------------------------------------
const FILES_DIR = mkdtempSync(path.join(os.tmpdir(), "dhyana-local-"));
process.on("exit", () => { try { rmSync(FILES_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });
const PLAN_LIMIT = Number(process.env.LOCAL_MAX_FILE_MB) > 0 ? Number(process.env.LOCAL_MAX_FILE_MB) * 1048576 : Infinity;
const FLAKY = process.env.LOCAL_FLAKY_UPLOADS === "1";   // test hook: every 3rd upload piece "fails" after arriving
const CHUNK = 6 * 1024 * 1024;                          // Supabase's resumable uploads take 6 MB pieces only
const uploads = new Map();                              // resumable upload id → { name, type, length, offset, file, role, sub }
let patchCount = 0;
const notFound = () => J({ statusCode: "404", error: "not_found", message: "Object not found" }, 404);

async function bucketRules() {
  const [b] = await sql(`select file_size_limit, allowed_mime_types from storage.buckets where id = 'room-images'`);
  return { limit: Math.min(Number(b?.file_size_limit) || Infinity, PLAN_LIMIT), types: b?.allowed_mime_types || [] };
}
function fileProblem(rules, type, size) {
  if (!rules.types.includes(type)) return J({ statusCode: "415", error: "invalid_mime_type", message: `mime type ${type} is not supported` }, 415);
  if (size > rules.limit) return J({ statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" }, 413);
  return null;
}
async function isAdminAs(role, sub) {
  if (role === "service_role") return true;
  return (await asRole(role, sub, () => db.query(`select public.is_admin() as ok`))).rows[0].ok === true;
}
function stored(name, type, file, size) {
  const old = files.get(name);
  if (old && old.file !== file) { try { unlinkSync(old.file); } catch { /* gone */ } }
  files.set(name, { type, file, size });
  log(`${type.startsWith("video/") ? "video" : "photo"} uploaded: ${name} (${size >= 1048576 ? (size / 1048576).toFixed(1) + " MB" : Math.round(size / 1024) + " KB"})`);
}

async function storage(url, method, headers, bytes) {
  const u = new URL(url);
  const origin = `http://${headers.get("host")}`;   // already checked to be this computer

  // Standard upload (one request) and delete
  const obj = /^\/storage\/v1\/object\/room-images\/([\w.-]{1,200})$/.exec(u.pathname);
  if (obj && (method === "POST" || method === "PUT" || method === "DELETE")) {
    const [role, sub] = who(headers);
    const stop = denied(role); if (stop) return stop;
    const name = obj[1];
    if (method === "DELETE") {
      const res = await asRole(role, sub, () => db.query(`delete from storage.objects where bucket_id = 'room-images' and name = $1 returning name`, [name]));
      if (!res.rows.length) return notFound();   // not there, or not allowed (RLS)
      const f = files.get(name);
      if (f) { try { unlinkSync(f.file); } catch { /* gone */ } files.delete(name); }
      log("file deleted:", name);
      return J([{ name }]);
    }
    const type = (headers.get("content-type") || "").split(";")[0].trim();
    const bad = fileProblem(await bucketRules(), type, bytes.length); if (bad) return bad;
    if (files.has(name) && headers.get("x-upsert") !== "true") return J({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }, 409);
    try {
      await asRole(role, sub, () => db.query(`insert into storage.objects (bucket_id, name) values ('room-images', $1)`, [name]));
    } catch (e) {
      return J({ statusCode: "403", error: "Unauthorized", message: e.message }, 403);
    }
    const file = path.join(FILES_DIR, name);
    writeFileSync(file, bytes);
    stored(name, type, file, bytes.length);
    return J({ Key: `room-images/${name}` });
  }

  // Resumable (TUS) upload: start one
  if (u.pathname === "/storage/v1/upload/resumable" && method === "POST") {
    const [role, sub] = who(headers);
    const stop = denied(role); if (stop) return stop;
    if (headers.get("tus-resumable") !== "1.0.0") return new Response("Tus-Resumable 1.0.0 required", { status: 412 });
    if (!(await isAdminAs(role, sub))) return J({ statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" }, 403);
    const length = Number(headers.get("upload-length"));
    if (!Number.isSafeInteger(length) || length < 0) return J({ error: "invalid_upload_length" }, 400);
    const meta = {};
    for (const pair of String(headers.get("upload-metadata") || "").split(",")) {
      const [k, v = ""] = pair.trim().split(" ");
      if (k) meta[k] = Buffer.from(v, "base64").toString("utf8");
    }
    if (meta.bucketName !== "room-images" || !/^[\w.-]{1,200}$/.test(meta.objectName || "")) return J({ error: "invalid_metadata" }, 400);
    const bad = fileProblem(await bucketRules(), meta.contentType, length); if (bad) return bad;
    if (files.has(meta.objectName) && headers.get("x-upsert") !== "true") return J({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }, 409);
    const id = randomBytes(12).toString("hex");
    const file = path.join(FILES_DIR, `upload-${id}`);
    writeFileSync(file, "");
    uploads.set(id, { name: meta.objectName, type: meta.contentType, length, offset: 0, file, role, sub });
    return new Response(null, { status: 201, headers: { location: `${origin}/storage/v1/upload/resumable/${id}`, "tus-resumable": "1.0.0" } });
  }

  // Resumable (TUS) upload: send a piece, or ask how far it got
  const tus = /^\/storage\/v1\/upload\/resumable\/([a-f0-9]{24})$/.exec(u.pathname);
  if (tus) {
    const upl = uploads.get(tus[1]);
    if (!upl) return notFound();
    const [role, sub] = who(headers);
    if (role !== upl.role || sub !== upl.sub) return J({ statusCode: "403", error: "Unauthorized", message: "Not your upload" }, 403);
    const h = { "tus-resumable": "1.0.0", "upload-offset": String(upl.offset), "upload-length": String(upl.length), "cache-control": "no-store" };
    if (method === "HEAD") return new Response(null, { status: 200, headers: h });
    if (method !== "PATCH") return new Response(null, { status: 405 });
    if (Number(headers.get("upload-offset")) !== upl.offset) return new Response(null, { status: 409, headers: h });
    if (headers.get("content-type") !== "application/offset+octet-stream") return new Response(null, { status: 415, headers: h });
    if (upl.offset + bytes.length > upl.length) return J({ error: "too_much_data" }, 400);
    if (bytes.length !== CHUNK && upl.offset + bytes.length !== upl.length) return J({ error: "invalid_chunk", message: "Pieces must be exactly 6 MB (the last may be smaller)" }, 400);
    appendFileSync(upl.file, bytes);
    upl.offset += bytes.length;
    if (upl.offset === upl.length) {
      try {
        await asRole(upl.role, upl.sub, () => db.query(`insert into storage.objects (bucket_id, name) values ('room-images', $1)`, [upl.name]));
      } catch (e) {
        uploads.delete(tus[1]); try { unlinkSync(upl.file); } catch { /* gone */ }
        return J({ statusCode: "403", error: "Unauthorized", message: e.message }, 403);
      }
      const final = path.join(FILES_DIR, upl.name);
      try { unlinkSync(final); } catch { /* none yet */ }
      renameSync(upl.file, final);
      stored(upl.name, upl.type, final, upl.length);
      uploads.delete(tus[1]);
    }
    if (FLAKY && ++patchCount % 3 === 0 && upl.offset < upl.length) {
      log("(test) pretending the connection dropped after", upl.offset, "bytes");
      return new Response("flaky", { status: 502 });
    }
    return new Response(null, { status: 204, headers: { ...h, "upload-offset": String(upl.offset) } });
  }
  return J({ statusCode: "404", error: "not_found", message: "Not available in local test mode" }, 404);
}

// Public files, streamed with byte ranges so videos can seek.
function serveStored(req, res, name) {
  const f = files.get(name);
  if (!f) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" })); return; }
  const size = f.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  let start = 0, end = size - 1, status = 200;
  if (m && size && (m[1] !== "" || m[2] !== "")) {
    if (m[1] === "") start = Math.max(0, size - Number(m[2]));
    else { start = Number(m[1]); if (m[2] !== "") end = Math.min(size - 1, Number(m[2])); }
    if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return; }
    status = 206;
  }
  const head = { "content-type": f.type, "accept-ranges": "bytes", "content-length": String(Math.max(0, end - start + 1)), "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (status === 206) head["content-range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, head);
  if (req.method === "HEAD" || size === 0) { res.end(); return; }
  createReadStream(f.file, { start, end }).on("error", () => res.destroy()).pipe(res);
}

// ---------------------------------------------------------------------
//  Booking server: the real supabase/functions/booking-api code
// ---------------------------------------------------------------------
const FN_ENV = {
  SUPABASE_URL: BASE, SERVICE_KEY: SERVICE,
  RAZORPAY_KEY_ID: RZP.keyId, RAZORPAY_KEY_SECRET: RZP.secret, RAZORPAY_WEBHOOK_SECRET: RZP.webhookSecret,
  ALLOWED_ORIGINS: ORIGINS.join(","), IP_HASH_SALT: randomBytes(16).toString("hex"),
  RESEND_API_KEY: "re_local_fake", EMAIL_FROM: "Dhyana Stays <bookings@example.com>", OWNER_EMAIL: OWNER.email,
  SITE_NAME: "Dhyana Stays", SITE_URL: BASE,
};
let edge;
globalThis.Deno = { env: { get: (k) => FN_ENV[k] }, serve: (h) => { edge = h; } };
globalThis.EdgeRuntime = { waitUntil: (p) => { Promise.resolve(p).catch((e) => log("background task failed:", e?.message || e)); } };

function addEmail({ to, subject, html }) {
  outbox.unshift({ at: new Date(), to: [].concat(to || []).join(", "), subject: String(subject || ""), html: String(html || "") });
  if (outbox.length > 200) outbox.pop();
  log(`email → ${[].concat(to || []).join(", ")}: ${subject}   (see ${BASE}/__local/emails)`);
}

// The function's own outgoing calls: Supabase → this server, Razorpay and Resend → fakes.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const bodyText = typeof init.body === "string" ? init.body : init.body ? String(init.body) : "";
  if (url.startsWith(BASE + "/rest/v1/")) return postgrest(url, method, headers, bodyText);
  if (url === "https://api.razorpay.com/v1/orders") {
    if (headers.get("authorization") !== "Basic " + Buffer.from(`${RZP.keyId}:${RZP.secret}`).toString("base64"))
      return J({ error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } }, 401);
    const b = JSON.parse(bodyText);
    const id = "order_LOCAL" + randomBytes(5).toString("hex");
    orders.set(id, { amount: b.amount, currency: b.currency });
    return J({ id, entity: "order", amount: b.amount, currency: b.currency, receipt: b.receipt, status: "created" });
  }
  if (url === "https://api.resend.com/emails") { addEmail(JSON.parse(bodyText)); return J({ id: "local-" + randomUUID() }); }
  return realFetch(input, init);
};
await import(pathToFileURL(path.join(ROOT, "supabase/functions/booking-api/index.ts")).href);
if (typeof edge !== "function") { console.error("booking-api did not start (Deno.serve was not called)"); process.exit(1); }

function callEdge(url, method, headers, bytes, ip) {
  const h = new Headers(headers);
  h.set("x-forwarded-for", ip);
  return edge(new Request(url, { method, headers: h, body: method === "GET" || method === "HEAD" ? undefined : bytes }));
}

// Fake Razorpay checkout → "payment succeeded": sign it like Razorpay, and send the webhook too.
async function fakePay(bodyText) {
  const b = parseJson(bodyText) || {};
  const order = orders.get(String(b.order_id || ""));
  if (!order) return J({ error: "unknown_order" }, 404);
  const orderId = String(b.order_id), paymentId = "pay_LOCAL" + randomBytes(5).toString("hex");
  const signature = createHmac("sha256", RZP.secret).update(`${orderId}|${paymentId}`).digest("hex");
  setTimeout(async () => {
    const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: {
      id: paymentId, order_id: orderId, amount: order.amount, currency: order.currency, status: "captured", method: "card" } } } });
    try {
      const res = await callEdge(`${BASE}/functions/v1/booking-api/webhook`, "POST",
        { "content-type": "application/json", "x-razorpay-signature": createHmac("sha256", RZP.webhookSecret).update(raw).digest("hex") },
        Buffer.from(raw), "127.0.0.1");
      log(`fake Razorpay webhook for ${orderId} → ${res.status} ${await res.text()}`);
    } catch (e) { log("fake Razorpay webhook failed:", e.message); }
  }, 3000);
  log(`fake payment ${paymentId} for ${orderId} (₹${(order.amount / 100).toLocaleString("en-IN")})`);
  return J({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature });
}

// ---------------------------------------------------------------------
//  The website (web/), with local test mode switched on
// ---------------------------------------------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".json": "application/json", ".woff2": "font/woff2" };

// The live site's security policy, minus the https-only upgrade (this server is plain http).
let CSP = "";
try {
  CSP = (/^\s*Content-Security-Policy:\s*(.+)$/m.exec(readFileSync(path.join(WEB, "_headers"), "utf8"))?.[1] || "")
    .split(";").map((s) => s.trim()).filter((s) => s && s !== "upgrade-insecure-requests").join("; ");
} catch { /* no _headers file */ }

function staticFile(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return new Response("Bad path", { status: 400 }); }
  if (rel === "/") rel = "/index.html";
  if (rel === "/admin") rel = "/admin.html";
  const file = path.resolve(WEB, "." + rel);
  if (!file.startsWith(WEB + path.sep) || path.basename(file).startsWith("_") || !existsSync(file))
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  const ext = path.extname(file).toLowerCase();
  const headers = { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" };
  let body = readFileSync(file);
  if (rel === "/config.js") {
    body = Buffer.concat([body, Buffer.from(`
;/* added by the local test server (not in your config.js) */
window.SITE_CONFIG.supabase = { url: location.origin, key: ${JSON.stringify(PUBLISHABLE)} };
window.SITE_CONFIG.turnstileSiteKey = "";
`)]);
  }
  if (ext === ".html") {
    const html = String(body);
    const tag = '<script src="js/common.js" defer></script>';
    body = html.includes(tag) ? html.replace(tag, `${tag}\n  <script src="__local/browser.js" defer></script>`) : html;
    if (!html.includes(tag)) log(`warning: ${rel} has no common.js script tag, so local test mode isn't switched on there`);
    if (CSP) headers["content-security-policy"] = CSP;
    if (rel === "/admin.html") headers["referrer-policy"] = "no-referrer";
  }
  return new Response(body, { headers });
}

function browserScript() {
  const settings = { port: PORT, owner: OWNER, notAdmin: NOT_ADMIN };
  const js = `window.__LOCAL = ${JSON.stringify(settings)};\n` + readFileSync(path.join(HERE, "browser.js"), "utf8");
  return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
}

function emailsPage() {
  const rows = outbox.map((m, i) => `
    <details${i === 0 ? " open" : ""}>
      <summary><b>${escHtml(m.subject)}</b><span>to ${escHtml(m.to)} · ${escHtml(m.at.toLocaleString("en-IN"))}</span></summary>
      <iframe sandbox="allow-popups allow-top-navigation-by-user-activation" referrerpolicy="no-referrer" srcdoc="${escHtml(m.html)}"></iframe>
    </details>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Emails · local test mode</title>
<style>
  :root { color-scheme: light dark; --ink: #2F3522; --paper: #FBFBF8; --line: #DDE2CE; --muted: #6B7280; }
  @media (prefers-color-scheme: dark) { :root { --ink: #ECEEE6; --paper: #1D2117; --line: #3A4130; --muted: #A3A89A; } }
  body { margin: 0; padding: 24px 16px; font: 15px/1.5 system-ui, sans-serif; color: var(--ink); background: var(--paper); }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; } p { color: var(--muted); margin: 0 0 20px; }
  details { border: 1px solid var(--line); border-radius: 10px; margin: 0 0 12px; overflow: hidden; }
  summary { cursor: pointer; padding: 12px 14px; display: flex; flex-wrap: wrap; gap: 4px 12px; }
  summary span { color: var(--muted); font-size: 13px; }
  iframe { width: 100%; height: 420px; border: 0; border-top: 1px solid var(--line); background: #fff; }
  a { color: inherit; }
</style></head><body><main>
<h1>Emails the site tried to send</h1>
<p>Local test mode: nothing was actually sent. Newest first. <a href="/__local/emails">Refresh</a> · <a href="/">Website</a> · <a href="/admin.html">Owner login</a></p>
${rows || "<p>None yet. Make a booking on the website, or use “Forgot password” on the owner login.</p>"}
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; frame-src 'self'; base-uri 'none'; form-action 'none'" } });
}

// ---------------------------------------------------------------------
//  HTTP server
// ---------------------------------------------------------------------
async function handle(req) {
  const url = `${BASE}${req.url}`;
  const { pathname } = new URL(url);
  const method = req.method.toUpperCase();
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > CHUNK + 1048576) return new Response("Too large", { status: 413 }); chunks.push(c); }
  const bytes = Buffer.concat(chunks);
  const ip = (req.socket.remoteAddress || "127.0.0.1").replace(/^::ffff:/, "");

  if (pathname.startsWith("/rest/v1/")) return postgrest(url, method, headers, bytes.toString("utf8"));
  if (pathname.startsWith("/auth/v1/")) return gotrue(url, method, headers, bytes.toString("utf8"));
  if (pathname.startsWith("/storage/v1/")) return storage(url, method, headers, bytes);
  if (pathname.startsWith("/functions/v1/booking-api/")) return callEdge(url, method, headers, bytes, ip);
  if (pathname === "/__local/browser.js") return browserScript();
  if (pathname === "/__local/pay" && method === "POST") return fakePay(bytes.toString("utf8"));
  if (pathname === "/__local/emails" || pathname === "/__local/" || pathname === "/__local") return emailsPage();
  if (method === "GET" || method === "HEAD") return staticFile(pathname);
  return new Response("Not found", { status: 404 });
}

async function onRequest(req, res) {
  // Only answer to this computer's own addresses (stops other websites reaching it via DNS tricks).
  if (!HOSTS.has(String(req.headers.host || "").toLowerCase())) { res.writeHead(400, { "content-type": "text/plain" }); res.end("Use " + BASE); return; }
  const pub = /^\/storage\/v1\/object\/public\/room-images\/([\w.-]{1,200})$/.exec(String(req.url).split("?")[0]);
  if (pub && (req.method === "GET" || req.method === "HEAD")) { serveStored(req, res, pub[1]); return; }
  let out;
  try { out = await handle(req); } catch (e) { log("error:", e?.stack || e); out = J({ error: "local_server_error", message: String(e?.message || e) }, 500); }
  const head = {}; out.headers.forEach((v, k) => { head[k] = v; });
  res.writeHead(out.status, head);
  res.end(req.method === "HEAD" || !out.body ? undefined : Buffer.from(await out.arrayBuffer()));
  if (out.status >= 400 && !req.url.startsWith("/favicon")) log(`${req.method} ${req.url.split("?")[0]} → ${out.status}`);
}

const servers = [];
function listen(host) {
  return new Promise((resolve) => {
    const s = http.createServer(onRequest);
    s.once("error", (e) => resolve(e));
    s.listen(PORT, host, () => { servers.push(s); resolve(null); });
  });
}
const err4 = await listen("127.0.0.1");
if (err4) {
  console.error(err4.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Stop the other program, or run with another port:  $env:PORT=8788; npm run local` : err4.message);
  process.exit(1);
}
// Also on IPv6, so http://localhost works on computers that prefer it. If IPv6 is off that's fine,
// but if another program (often an old copy of this server) holds it, localhost would quietly reach
// that program instead, so stop.
const err6 = await listen("::1");
if (err6 && err6.code === "EADDRINUSE") {
  console.error(`Port ${PORT} is already in use on [::1] (often an earlier copy of this server that's still running). Close it, or run with another port:  $env:PORT=8788; npm run local`);
  process.exit(1);
}

console.log(`
  Local test server is running. Nothing here touches Supabase, Razorpay or real email.

    Website       ${BASE}
    Owner login   ${BASE}/admin.html
                  email     ${OWNER.email}
                  password  ${OWNER.password}
    Not an admin  ${NOT_ADMIN.email} / ${NOT_ADMIN.password}  (should be refused)
    Emails        ${BASE}/__local/emails

  Sample places: Auroville, plus Kodaikanal (sample, local only).
  Sample bookings: ${seeded.length ? seeded.join("; ") : "none"}.
  Payments use a fake Razorpay window. Everything resets when you stop the server: Ctrl+C.
`);
const stop = () => { servers.forEach((s) => s.close()); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
