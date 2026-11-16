// Runs supabase/setup.sql on PGlite (real Postgres in WASM) with Supabase-like stubs, then tests behaviour.
// usage: node db.test.mjs <path-to-pgdeps> <path-to-setup.sql>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const [deps, sqlPath] = process.argv.slice(2);
const pg = await import(pathToFileURL(path.join(deps, "node_modules/@electric-sql/pglite/dist/index.js")).href);
const { btree_gist } = await import(pathToFileURL(path.join(deps, "node_modules/@electric-sql/pglite/dist/contrib/btree_gist.js")).href);
const db = new pg.PGlite({ extensions: { btree_gist } });
const fatal = (e) => { console.log("FATAL:", e.message, "| where:", e.where || "", "| query:", e.query || ""); process.exit(1); };
process.on("uncaughtException", fatal); process.on("unhandledRejection", fatal);

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => { if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name, extra); } };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
async function err(sql, params) { try { await db.query(sql, params); return null; } catch (e) { return e.message; } }
async function as(role, sub = "") {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${sub}', false);`);
  if (role !== "postgres") await db.exec(`set role ${role};`);
}

// ---- Supabase stubs -------------------------------------------------
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema extensions; create schema auth; create schema storage;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant all on storage.objects to anon, authenticated, service_role;   -- as on Supabase; RLS does the gating
  grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  -- Supabase's default privileges: API roles get full table + function grants in public
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`);

console.log("setup.sql");
const setup = readFileSync(sqlPath, "utf8");
await db.exec(setup);
ok(true, "runs cleanly on an empty database");
await db.exec(setup);
ok(true, "runs cleanly a second time (re-runnable)");

const ADMIN = "11111111-1111-1111-1111-111111111111", USER = "22222222-2222-2222-2222-222222222222";
await db.exec(`insert into auth.users values ('${ADMIN}','owner@example.com'), ('${USER}','random@example.com');
               insert into public.admins (user_id) values ('${ADMIN}');`);

const today = (await one(`select public.local_today()::text as d`)).d;
const day = (n) => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Find a future Monday so weekday/weekend pricing is deterministic
let mon = 14; while (new Date(day(mon) + "T00:00:00Z").getUTCDay() !== 1) mon++;

const book = (o = {}) => {
  const a = { room: "garden-room", ci: day(mon), co: day(mon + 2), units: 1, guests: 2, name: "Asha", email: "asha@example.com",
              phone: "+91 98765 43210", req: null, mode: "online", ip: "ip1", admin: false, ...o };
  return db.query(`select public.create_booking($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as b`,
    [a.room, a.ci, a.co, a.units, a.guests, a.name, a.email, a.phone, a.req, a.mode, a.ip, a.admin]).then(r => r.rows[0].b);
};

// ---- Public (anon) access --------------------------------------------
console.log("public visitor (anon)");
await as("anon");
ok(/permission denied/.test(await err(`select * from public.bookings`)), "cannot read bookings");
ok(/permission denied/.test(await err(`insert into public.bookings (room_id) values ('x')`)), "cannot insert bookings");
ok(/permission denied/.test(await err(`update public.rooms set price_per_night = 1`)), "cannot change room prices");
ok(/permission denied/.test(await err(`select public.create_booking('garden-room', current_date+5, current_date+6, 1, 1, 'x','x@x.co','9999999','', 'online')`)), "cannot call create_booking directly");
ok(/permission denied/.test(await err(`select public.confirm_payment('order_x','pay_x')`)), "cannot fake a payment confirmation");
ok(/permission denied/.test(await err(`select public.admin_set_status('${ADMIN}', 'cancelled')`)) || /not_authorised/.test(await err(`select public.admin_set_status('${ADMIN}', 'cancelled')`)), "cannot run admin functions");
ok(/permission denied/.test(await err(`select * from public.invoice_counters`)), "cannot read invoice counters");
ok(/permission denied/.test(await err(`insert into storage.objects (bucket_id, name) values ('room-images','x.jpg')`)) || /row-level security/.test(await err(`insert into storage.objects (bucket_id, name) values ('room-images','x.jpg')`)), "cannot upload photos");
const rooms = await q(`select id from public.rooms order by sort_order`);
ok(rooms.length === 2, "can read active rooms", JSON.stringify(rooms));
ok((await q(`select * from public.settings`)).length === 1, "can read settings");
const qt = (await one(`select public.quote_stay('garden-room', $1, $2, 1) as q`, [day(mon), day(mon + 2)])).q;
ok(qt.total_paise === 600000 && qt.nights === 2, "quote: 2 weekday nights × ₹3,000 = ₹6,000 (GST off)", JSON.stringify(qt));
ok(/date_in_past/.test(await err(`select public.quote_stay('garden-room', $1, $2, 1)`, [day(-1), day(1)])), "quote rejects past check-in");
ok(/invalid_units/.test(await err(`select public.quote_stay('garden-room', $1, $2, 3)`, [day(mon), day(mon + 1)])), "quote rejects more units than exist");

// ---- Signed-in non-admin -------------------------------------------
console.log("signed-in user who is NOT an admin");
await as("authenticated", USER);
ok((await q(`select * from public.bookings`)).length === 0, "sees zero bookings");
ok(/not_authorised/.test(await err(`select public.admin_set_status('${ADMIN}', 'cancelled')`)), "admin functions refuse");
ok(/row-level security|0 rows/.test(await err(`insert into public.rooms (id, name) values ('hack','Hack')`) || "0 rows"), "cannot add rooms");
await db.query(`update public.rooms set price_per_night = 1 where id = 'garden-room'`);
await as("postgres");
ok((await one(`select price_per_night from public.rooms where id='garden-room'`)).price_per_night === 3000, "price update silently blocked by RLS");

// ---- Booking engine (service role, as the edge function) -------------
console.log("booking engine");
await as("service_role");
const b1 = await book();
ok(b1.status === "hold" && b1.source === "online" && b1.total_paise === 600000, "online booking → 30-min hold with server price", JSON.stringify(b1).slice(0, 200));
ok(b1.client_ip_hash === undefined, "returned JSON hides the IP hash");
const b2 = await book({ email: "ben@example.com", phone: "+91 90000 00001", ip: "ip2" });
ok(b2.status === "hold", "2nd booking takes the 2nd unit (garden-room has 2)");
ok(/not_available/.test(await err(`select public.create_booking('garden-room',$1,$2,1,2,'Cy','cy@example.com','+91 90000 00002',null,'arrival','ip3')`, [day(mon + 1), day(mon + 3)])), "3rd overlapping booking refused — no double booking");
const b3 = await book({ ci: day(mon + 2), co: day(mon + 3), email: "dee@example.com", phone: "+91 90000 00003", ip: "ip4", mode: "arrival" });
ok(b3.status === "hold", "back-to-back stay (check-in on another's check-out day) allowed");
const av = await q(`select night::text, booked from public.get_availability('garden-room', $1, $2)`, [day(mon), day(mon + 4)]);
ok(av.map(r => r.booked).join(",") === "2,2,1,0", "availability counts per night", JSON.stringify(av));
ok(/too_many_guests/.test(await err(`select public.create_booking('garden-room',$1,$2,1,9,'E','e@example.com','+91 90000 00004',null,'online','ip5')`, [day(mon + 10), day(mon + 11)])), "guest count enforced per room");
ok(/contact_required/.test(await err(`select public.create_booking('garden-room',$1,$2,1,1,'E','','',null,'online','ip5')`, [day(mon + 10), day(mon + 11)])), "email + phone required");
ok(/check constraint/.test(await err(`select public.create_booking('garden-room',$1,$2,1,1,'E','not-an-email','+91 90000 00004',null,'online','ip5')`, [day(mon + 10), day(mon + 11)])), "invalid email rejected");
ok(/invalid_mode/.test(await err(`select public.create_booking('garden-room',$1,$2,1,1,'E','e@example.com','+91 90000 00004',null,'free','ip5')`, [day(mon + 10), day(mon + 11)])), "unknown payment mode rejected");

// direct overlapping insert is rejected by the exclusion constraint itself
await as("postgres");
// b2 holds unit 2; try to also give b2 unit 1, which b1 already occupies on these nights
const exMsg = await err(`insert into public.booking_units (booking_id, room_id, unit_no, stay) values ($1, 'garden-room', 1, daterange($2::date, $3::date))`, [b2.id, day(mon), day(mon + 1)]);
ok(/no_double_booking/.test(exMsg), "database constraint blocks overlap even for direct inserts", exMsg);

// retrying online payment replaces your own previous hold
await as("service_role");
const b1b = await book({ ci: day(mon), co: day(mon + 2) });
await as("postgres");
ok((await one(`select status from public.bookings where id=$1`, [b1.id])).status === "expired" && b1b.status === "hold", "guest retrying payment replaces their own earlier unpaid hold");

// expiry frees the dates
await db.query(`update public.bookings set hold_expires_at = now() - interval '1 minute' where id = $1`, [b2.id]);
await as("service_role");
const b4 = await book({ email: "fay@example.com", phone: "+91 90000 00005", ip: "ip6", mode: "arrival" });
ok(b4.status === "hold", "expired hold frees its unit for the next guest");
await as("postgres");
ok((await one(`select status from public.bookings where id=$1`, [b2.id])).status === "expired", "expired hold is marked expired");
const hrs = (await one(`select round(extract(epoch from hold_expires_at - now())/3600) h from public.bookings where id=$1`, [b4.id])).h;
ok(Number(hrs) === 24, "pay-on-arrival hold lasts 24 hours", hrs);

// anti-abuse
await as("service_role");
for (let i = 0; i < 3; i++) await book({ ci: day(mon + 20 + i * 2), co: day(mon + 21 + i * 2), email: "spam@example.com", phone: "+91 91111 11111", ip: "ipS", mode: "arrival", room: "garden-room" }).catch(() => {});
ok(/too_many_holds/.test(await err(`select public.create_booking('garden-room',$1,$2,1,1,'S','spam@example.com','+91 91111 11111',null,'arrival','ipS')`, [day(mon + 40), day(mon + 41)])), "4th live hold from same guest refused");

// different guests behind one shared mobile IP (carrier NAT) are not blocked by each other
let nat = 0;
for (let i = 0; i < 4; i++) {
  const r = await book({ ci: day(mon + 70 + i * 2), co: day(mon + 71 + i * 2), email: `nat${i}@example.com`, phone: `+91 92222 0000${i}`, ip: "ipNAT", mode: "arrival" }).catch((e) => e.message);
  if (r && r.status === "hold") nat++;
}
ok(nat === 4, "4 different guests on one shared IP can all book", nat);

// inquiry (no price) does not block dates
const inq = await book({ room: "cottage", mode: "online", email: "gia@example.com", phone: "+91 90000 00006", ip: "ip7" });
const inq2 = await book({ room: "cottage", mode: "online", email: "hal@example.com", phone: "+91 90000 00007", ip: "ip8" });
ok(inq.status === "inquiry" && inq2.status === "inquiry", "unpriced room → inquiry, never blocks dates");

// ---- Payments ---------------------------------------------------------
console.log("payments + invoices");
await db.query(`select public.set_razorpay_order($1, 'order_AAA')`, [b1b.id]);
const p1 = (await one(`select public.confirm_payment('order_AAA', 'pay_AAA', 600000) as b`)).b;
ok(p1.status === "confirmed" && p1.payment_status === "paid" && p1.newly_paid === true, "verified payment confirms the booking");
ok(/^DS\/\d\d-\d\d\/0001$/.test(p1.invoice_no), "sequential invoice number issued", p1.invoice_no);
const p1again = (await one(`select public.confirm_payment('order_AAA', 'pay_AAA', 600000) as b`)).b;
ok(p1again.newly_paid === false && p1again.invoice_no === p1.invoice_no, "confirming twice (browser + webhook) is harmless");
ok(/booking_not_found/.test(await err(`select public.confirm_payment('order_UNKNOWN', 'pay_X')`)), "unknown order rejected");

// paid after hold expired, dates now taken → flagged, not double-booked
const late = await book({ ci: day(mon + 50), co: day(mon + 51), room: "garden-room", units: 2, guests: 2, email: "ivy@example.com", phone: "+91 90000 00008", ip: "ip9" });
await db.query(`select public.set_razorpay_order($1, 'order_LATE')`, [late.id]);
await as("postgres");
await db.query(`update public.bookings set hold_expires_at = now() - interval '1 minute' where id = $1`, [late.id]);
await as("service_role");
await book({ ci: day(mon + 50), co: day(mon + 51), email: "jo@example.com", phone: "+91 90000 00009", ip: "ip10", mode: "arrival" });
const lp = (await one(`select public.confirm_payment('order_LATE', 'pay_LATE', 600000) as b`)).b;
ok(lp.payment_status === "paid" && lp.status === "expired" && lp.needs_attention === true && !lp.invoice_no, "late payment for taken dates → flagged for refund, no double booking");

// paid after hold expired but dates still free → confirmed
const late2 = await book({ ci: day(mon + 60), co: day(mon + 61), email: "kai@example.com", phone: "+91 90000 00010", ip: "ip11" });
await db.query(`select public.set_razorpay_order($1, 'order_LATE2')`, [late2.id]);
await as("postgres");
await db.query(`update public.bookings set hold_expires_at = now() - interval '1 minute' where id = $1`, [late2.id]);
await db.query(`select public.expire_stale_holds()`);
await as("service_role");
const lp2 = (await one(`select public.confirm_payment('order_LATE2', 'pay_LATE2') as b`)).b;
ok(lp2.status === "confirmed" && lp2.invoice_no, "late payment with dates still free → confirmed");

// ---- GST ----------------------------------------------------------------
console.log("GST");
await as("postgres");
const rates = await q(`select t, public.gst_rate_for(t) r from unnest(array[900,1000,1001,2500,7500,7501,12000]) t`);
ok(rates.map(r => r.r).join(",") === "0,0,5,5,5,18,18", "slabs: ≤1000 0% · ≤7500 5% · >7500 18%", JSON.stringify(rates));
await db.exec(`update public.settings set gst_enabled = true, gstin = '33ABCDE1234F1Z5'`);
// Thursday → Sunday = Thu, Fri, Sat nights: 1 weekday @3000 + 2 weekend @3500
let thu = mon + 3;
const g = (await one(`select public.compute_quote('garden-room', $1, $2, 1) q`, [day(thu), day(thu + 3)])).q;
ok(g.subtotal_paise === 1000000 && g.gst_paise === 50000 && g.total_paise === 1050000, "Thu–Sun: ₹3,000 + 2×₹3,500 + 5% GST = ₹10,500", JSON.stringify({ s: g.subtotal_paise, g: g.gst_paise }));
await db.exec(`update public.rooms set weekend_price = 8000 where id = 'garden-room'`);
const g2 = (await one(`select public.compute_quote('garden-room', $1, $2, 1) q`, [day(thu), day(thu + 3)])).q;
ok(g2.gst_paise === 15000 /* ₹3,000×5% */ + 288000 /* 2×₹8,000×18% */, "weekend nights above ₹7,500 taxed at 18%, weekday at 5% (per night)", g2.gst_paise);
ok(/check constraint/.test(await err(`update public.settings set gstin = null`)), "GST can't be on without a GSTIN");
await db.exec(`update public.rooms set weekend_price = 3500 where id = 'garden-room'; update public.settings set gst_enabled = false`);

// ---- Admin --------------------------------------------------------------
console.log("admin");
await as("authenticated", ADMIN);
const all = await q(`select id, status from public.bookings`);
ok(all.length > 5, "admin sees all bookings", all.length);
ok(/permission denied/.test(await err(`update public.bookings set total_paise = 1 where id = $1`, [b4.id])), "admin cannot hand-edit amounts");
await db.query(`update public.bookings set admin_notes = 'VIP' where id = $1`, [b4.id]);
ok((await one(`select admin_notes from public.bookings where id=$1`, [b4.id])).admin_notes === "VIP", "admin can save notes");
const c = (await one(`select public.admin_set_status($1, 'confirmed') b`, [b4.id])).b;
ok(c.status === "confirmed" && c.hold_expires_at === null, "admin confirms a pay-on-arrival hold");
ok(/already_paid/.test(await err(`select public.admin_record_payment($1, 'cash')`, [p1.id])), "can't record payment twice");
const paidCash = (await one(`select public.admin_record_payment($1, 'upi') b`, [b4.id])).b;
ok(paidCash.payment_status === "paid" && /\/000[2-9]$/.test(paidCash.invoice_no), "recording a UPI payment issues the next invoice number", paidCash.invoice_no);
ok(/has_payment_records/.test(await err(`select public.admin_delete_booking($1)`, [b4.id])), "bookings with payments can't be deleted (cancel instead)");
const cx = (await one(`select public.admin_set_status($1, 'cancelled') b`, [b3.id])).b;
ok(cx.status === "cancelled", "admin cancels a booking");
const freed = await q(`select active from public.booking_units where booking_id=$1`, [b3.id]);
ok(freed.every(r => r.active === false), "cancelling frees the room unit");
const man = (await one(`select public.admin_create_booking('garden-room', $1, $2, 1, 2, 'Walk-in guest') b`, [day(mon + 2), day(mon + 3)])).b;
ok(man.status === "confirmed" && man.source === "manual", "admin adds a phone/walk-in booking that blocks dates");
ok(/dates_taken/.test(await err(`select public.admin_set_status($1, 'confirmed')`, [b3.id])), "re-confirming a cancelled booking whose dates were re-sold is refused");
await db.query(`select public.admin_delete_booking($1)`, [inq.id]);
ok((await q(`select 1 from public.bookings where id=$1`, [inq.id])).length === 0, "admin deletes an unpaid inquiry");
const up = await err(`insert into storage.objects (bucket_id, name) values ('room-images', 'garden-room-1.jpg')`);
ok(up === null, "admin can upload a room photo", up);
await db.query(`update public.rooms set price_per_night = 3200 where id = 'garden-room'`);
await as("postgres");
ok((await one(`select price_per_night from public.rooms where id='garden-room'`)).price_per_night === 3200, "admin can change prices");

// ---- Locations + admin-managed contact details --------------------------
console.log("locations + contact details");
await as("postgres");
const st = await one(`select * from public.settings`);
ok(st.contact_phones[0] === "+91 98400 36900" && st.contact_emails[0] === "support@dhyanastays.com" && st.invoice_prefix === "DS", "settings start with Dhyana Stays contact details");
const b1row = await one(`select location_id, location_name, quote->'location'->>'state' st from public.bookings where id = $1`, [b1.id]);
ok(b1row.location_name === "Auroville" && b1row.st === "Tamil Nadu", "bookings record their location (name + state for GST place of supply)");
await as("anon");
ok((await q(`select id from public.locations`)).length === 1, "public can read active locations");
ok(/permission denied/.test(await err(`insert into public.locations (id, name, state) values ('x','X','Goa')`)), "public can't add locations");
ok(/permission denied/.test(await err(`update public.settings set contact_phones = '{"+91 1"}'`)), "public can't change contact details");
await as("authenticated", USER);
await db.query(`update public.settings set contact_phones = '{"+91 99999 99999"}'`);
await as("postgres");
ok((await one(`select contact_phones from public.settings`)).contact_phones[0] === "+91 98400 36900", "non-admin can't change contact details (RLS)");
await as("authenticated", ADMIN);
await db.query(`update public.settings set contact_phones = '{"+91 90000 12345","0413 262 2000"}', contact_whatsapp = '+91 90000 12345', contact_map_url = 'https://maps.app.goo.gl/abc'`);
ok((await one(`select contact_phones from public.settings`)).contact_phones.length === 2, "admin updates contact phones");
ok(/check constraint/.test(await err(`update public.settings set contact_phones = '{"call me maybe"}'`)), "invalid phone number refused");
ok(/check constraint/.test(await err(`update public.settings set contact_emails = '{"not-an-email"}'`)), "invalid email refused");
ok(/check constraint/.test(await err(`update public.settings set contact_map_url = 'javascript:alert(1)'`)), "non-https map link refused");
await db.query(`insert into public.locations (id, name, area_label, state, gstin, sort_order) values ('goa-hills', 'Goa Hills', 'North Goa', 'Goa', '30ABCDE1234F1Z5', 2)`);
await db.query(`insert into public.rooms (id, location_id, name, max_guests, price_per_night, max_units) values ('hill-villa', 'goa-hills', 'Hill Villa', 4, 9000, 1)`);
ok((await q(`select id from public.rooms where location_id = 'goa-hills'`)).length === 1, "admin adds a second location with its own room");
await as("postgres");
await db.exec(`update public.settings set gst_enabled = true, gstin = '33ABCDE1234F1Z5'`);
const gq = (await one(`select public.compute_quote('hill-villa', $1, $2, 1) q`, [day(mon), day(mon + 1)])).q;
ok(gq.gstin === "30ABCDE1234F1Z5" && gq.location.state === "Goa" && gq.gst_paise === 162000, "location's own GSTIN + state used; ₹9,000 → 18% GST", JSON.stringify({ g: gq.gstin, s: gq.location?.state, p: gq.gst_paise }));
const aq = (await one(`select public.compute_quote('garden-room', $1, $2, 1) q`, [day(mon), day(mon + 1)])).q;
ok(aq.gstin === "33ABCDE1234F1Z5", "location without its own GSTIN falls back to the business GSTIN");
await db.exec(`update public.settings set gst_enabled = false`);
await db.query(`update public.locations set is_active = false where id = 'goa-hills'`);
await as("anon");
ok((await q(`select id from public.locations where id = 'goa-hills'`)).length === 0, "hidden location disappears from the public site");
ok(/room_not_found/.test(await err(`select public.quote_stay('hill-villa', $1, $2, 1)`, [day(mon), day(mon + 1)])), "rooms in a hidden location can't be quoted");
await as("service_role");
ok(/room_not_found/.test(await err(`select public.create_booking('hill-villa',$1,$2,1,2,'Z','z@example.com','+91 90000 77777',null,'online','ipZ')`, [day(mon), day(mon + 1)])), "…or booked by guests");
await as("authenticated", ADMIN);
const hv = (await one(`select public.admin_create_booking('hill-villa', $1, $2, 1, 2, 'Owner block') b`, [day(mon), day(mon + 1)])).b;
ok(hv.status === "confirmed" && hv.location_name === "Goa Hills", "admin can still block dates there");
ok(/foreign key|violates/.test(await err(`delete from public.locations where id = 'goa-hills'`)), "a location with rooms can't be deleted");

console.log("photos & videos");
const MB = 1048576;
const item = (type, name, size) => ({ type, url: `https://proj.supabase.co/storage/v1/object/public/room-images/${name}`, path: name, size });
const setMedia = (arr) => db.query(`update public.rooms set media = $1::jsonb where id = 'garden-room'`, [JSON.stringify(arr)]);
await as("authenticated", ADMIN);
await setMedia([item("video", "garden-tour.mp4", 300 * MB), item("image", "garden-1.jpg", 4 * MB), item("image", "garden-2.jpg", 3 * MB)]);
let gr = await one(`select media, image_url from public.rooms where id = 'garden-room'`);
ok(gr.media.length === 3 && gr.image_url.endsWith("/garden-1.jpg"), "admin saves photos + a video in order; cover photo = first photo in the list", gr.image_url);
await setMedia([item("image", "garden-2.jpg", 3 * MB), item("video", "garden-tour.mp4", 300 * MB)]);
ok((await one(`select image_url from public.rooms where id = 'garden-room'`)).image_url.endsWith("/garden-2.jpg"), "re-ordering changes the cover photo");
ok(/media_too_big/.test(await err(`update public.rooms set media = $1::jsonb where id = 'garden-room'`, [JSON.stringify([item("video", "a.mp4", 300 * MB), item("video", "b.mp4", 201 * MB)])])), "more than 500 MB in total for one stay is refused");
ok(!(await err(`update public.rooms set media = $1::jsonb where id = 'garden-room'`, [JSON.stringify([item("video", "a.mp4", 300 * MB), item("video", "b.mp4", 200 * MB)])])), "exactly 500 MB in total is allowed");
ok(/check constraint/.test(await err(`update public.rooms set media = $1::jsonb where id = 'garden-room'`, [JSON.stringify([item("image", "huge.jpg", 21 * MB)])])), "a photo over 20 MB is refused");
ok(/check constraint/.test(await err(`update public.rooms set media = $1::jsonb where id = 'garden-room'`, [JSON.stringify([{ ...item("image", "x.jpg", 1), url: "javascript:alert(1)" }])])), "a non-https link is refused");
ok(/check constraint/.test(await err(`update public.rooms set media = $1::jsonb where id = 'garden-room'`, [JSON.stringify([{ ...item("image", "x.jpg", 1), type: "pdf" }])])), "only photos and videos are accepted");
ok(/check constraint/.test(await err(`update public.rooms set media = $1::jsonb where id = 'garden-room'`, [JSON.stringify([{ ...item("image", "x.jpg", 1), path: "../other.jpg" }])])), "file names with paths are refused");
ok(/check constraint/.test(await err(`update public.rooms set media = $1::jsonb where id = 'garden-room'`, [JSON.stringify(Array.from({ length: 41 }, (_, i) => item("image", `p${i}.jpg`, 1)))])), "more than 40 items is refused");
await setMedia([item("video", "garden-tour.mp4", 300 * MB)]);
ok((await one(`select image_url from public.rooms where id = 'garden-room'`)).image_url === null, "a stay with only videos has no cover photo (the site shows the video)");
await setMedia([]);
ok((await one(`select media, image_url from public.rooms where id = 'garden-room'`)).image_url === null, "removing everything clears the cover photo");
await as("anon");
ok(/permission denied/.test(await err(`update public.rooms set media = '[]'::jsonb where id = 'cottage'`)), "the public can't change photos or videos");
await as("authenticated", USER);
await db.query(`update public.rooms set media = $1::jsonb where id = 'cottage'`, [JSON.stringify([item("image", "evil.jpg", 1)])]);
await as("postgres");
ok((await one(`select media from public.rooms where id = 'cottage'`)).media.length === 0, "a signed-in non-admin can't change them either (RLS)");
const bucket = await one(`select file_size_limit, allowed_mime_types from storage.buckets where id = 'room-images'`);
ok(Number(bucket.file_size_limit) === 500 * MB && bucket.allowed_mime_types.includes("video/mp4") && bucket.allowed_mime_types.includes("image/jpeg"), "storage bucket takes files up to 500 MB, photos and videos");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
