// =====================================================================
//  booking-api — the only server code a guest's browser talks to.
//
//   POST /functions/v1/booking-api/create   hold dates, price on the server, open a Razorpay order
//   POST /functions/v1/booking-api/verify   check Razorpay's signature → confirm + invoice number
//   POST /functions/v1/booking-api/webhook  same confirmation, sent by Razorpay (covers closed tabs)
//
//  Deploy with "Verify JWT" switched OFF — these endpoints are public and
//  each one checks its own input. Secrets are listed in the README.
//  Single file on purpose: it can be pasted into the Supabase dashboard.
// =====================================================================

const env = (k: string): string => (Deno.env.get(k) ?? "").trim();

const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SERVICE_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");
const RZP_KEY_ID = env("RAZORPAY_KEY_ID");
const RZP_KEY_SECRET = env("RAZORPAY_KEY_SECRET");
const RZP_WEBHOOK_SECRET = env("RAZORPAY_WEBHOOK_SECRET");
const ALLOWED_ORIGINS = env("ALLOWED_ORIGINS").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
const IP_HASH_SALT = env("IP_HASH_SALT");
const TURNSTILE_SECRET = env("TURNSTILE_SECRET");
const RESEND_API_KEY = env("RESEND_API_KEY");
const EMAIL_FROM = env("EMAIL_FROM");
const OWNER_EMAIL = env("OWNER_EMAIL");
const SITE_NAME = env("SITE_NAME") || "Dhyana Stays";
const SITE_URL = env("SITE_URL");

const MAX_BODY_BYTES = 16 * 1024;

class ClientError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Errors raised by the database that are safe (and useful) to show the guest.
const DB_CLIENT_ERRORS: Record<string, number> = {
  room_not_found: 404, invalid_dates: 422, date_in_past: 422, too_many_nights: 422, too_far_ahead: 422,
  invalid_units: 422, too_many_guests: 422, name_required: 422, contact_required: 422,
  arrival_disabled: 422, invalid_mode: 422, not_available: 409, too_many_holds: 429, rate_limited: 429,
  booking_not_found: 404,
};

// ---------------------------------------------------------------------
//  Small helpers
// ---------------------------------------------------------------------
function corsHeaders(req: Request): Record<string, string> {
  const origin = (req.headers.get("origin") ?? "").replace(/\/+$/, "");
  const allow = ALLOWED_ORIGINS.length === 0 ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function originAllowed(req: Request): boolean {
  if (ALLOWED_ORIGINS.length === 0) return true;
  const origin = (req.headers.get("origin") ?? "").replace(/\/+$/, "");
  return ALLOWED_ORIGINS.includes(origin);
}

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function readBody(req: Request): Promise<string> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new ClientError("payload_too_large", 413);
  return text;
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new ClientError("invalid_request");
}

function str(v: unknown, max: number, required = false): string {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new ClientError("invalid_request");
  const s = v.trim();
  if (s.length > max) throw new ClientError("invalid_request");
  if (required && !s) throw new ClientError("invalid_request");
  return s;
}

function int(v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new ClientError("invalid_request");
  return v;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clientIp(req: Request): string {
  return (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim();
}

function background(task: Promise<unknown>): void {
  const safe = task.catch((e) => console.error("background task failed:", e instanceof Error ? e.message : e));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(safe);
}

function requireConfig(...pairs: Array<[string, string]>): void {
  const missing = pairs.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error("booking-api is missing secrets:", missing.join(", "));
    throw new ClientError("not_configured", 503);
  }
}

// ---------------------------------------------------------------------
//  Database (PostgREST RPC with the service key — bypasses RLS by design)
// ---------------------------------------------------------------------
function serviceHeaders(): Record<string, string> {
  const headers: Record<string, string> = { apikey: SERVICE_KEY, "Content-Type": "application/json" };
  if (!SERVICE_KEY.startsWith("sb_")) headers.Authorization = `Bearer ${SERVICE_KEY}`;   // legacy JWT keys
  return headers;
}

async function rpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: serviceHeaders(), body: JSON.stringify(args) });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = (data ?? {}) as { code?: string; message?: string };
    const msg = err.message ?? "";
    if (msg in DB_CLIENT_ERRORS) throw new ClientError(msg, DB_CLIENT_ERRORS[msg]);
    if (err.code === "23514" || err.code === "22P02" || err.code === "22007" || err.code === "22008") throw new ClientError("invalid_details", 422);
    throw new Error(`db ${fn} failed: ${res.status} ${err.code ?? ""} ${msg}`);
  }
  return data as T;
}

type Booking = Record<string, unknown> & {
  id: string; ref: string; source: string; status: string; payment_status: string;
  total_paise: number; guest_name: string; guest_email: string | null; room_name: string; location_name?: string | null;
  check_in: string; check_out: string; newly_paid?: boolean; needs_attention?: boolean;
};

const GUEST_FIELDS = [
  "id", "ref", "room_name", "location_name", "num_units", "check_in", "check_out", "num_guests", "guest_name", "guest_email",
  "guest_phone", "special_requests", "source", "status", "payment_status", "payment_method", "needs_attention",
  "hold_expires_at", "quote", "subtotal_paise", "gst_paise", "total_paise", "razorpay_order_id",
  "razorpay_payment_id", "paid_at", "invoice_no", "invoice_date", "created_at",
];

function guestView(b: Booking): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of GUEST_FIELDS) out[k] = b[k] ?? null;
  return out;
}

// ---------------------------------------------------------------------
//  Razorpay
// ---------------------------------------------------------------------
async function razorpayCreateOrder(amountPaise: number, receipt: string, notes: Record<string, string>) {
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`), "Content-Type": "application/json" },
    body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt, notes }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.id !== "string") {
    throw new Error(`razorpay order failed: ${res.status} ${data?.error?.description ?? ""}`);
  }
  return data as { id: string; amount: number; currency: string };
}

// ---------------------------------------------------------------------
//  Optional: Cloudflare Turnstile (bot check) and Resend (emails)
// ---------------------------------------------------------------------
async function turnstilePassed(token: string, ip: string): Promise<boolean> {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new FormData();
  form.append("secret", TURNSTILE_SECRET);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  return data?.success === true;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(ymd: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ""));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
}
function fmtMoney(paise: unknown): string {
  const n = Number(paise ?? 0) / 100;
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!RESEND_API_KEY || !EMAIL_FROM || !to) return;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
  });
  if (!res.ok) console.error("email failed:", res.status, await res.text().catch(() => ""));
}

// Contact details are managed in admin → Settings; cached for 5 minutes.
let contactCache: { at: number; html: string } | null = null;
async function contactFooter(): Promise<string> {
  if (contactCache && Date.now() - contactCache.at < 300_000) return contactCache.html;
  let html = "";
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/settings?select=contact_phones,contact_emails`, { headers: serviceHeaders() });
    const s = res.ok ? ((await res.json())?.[0] ?? {}) : {};
    const bits = [...(s.contact_phones ?? []).slice(0, 2), ...(s.contact_emails ?? []).slice(0, 1)].map(esc);
    if (bits.length) html = `<p style="color:#777;font-size:13px">Questions? ${bits.join(" · ")}</p>`;
  } catch { /* emails still go out without it */ }
  contactCache = { at: Date.now(), html };
  return html;
}

function bookingSummaryHtml(b: Booking): string {
  const rows: Array<[string, string]> = [
    ["Reference", esc(b.ref)],
    ["Room", esc(b.room_name) + (Number(b.num_units) > 1 ? ` × ${esc(b.num_units)}` : "") + (b.location_name ? ` — ${esc(b.location_name)}` : "")],
    ["Check-in", fmtDate(b.check_in)],
    ["Check-out", fmtDate(b.check_out)],
    ["Guests", esc(b.num_guests)],
    ["Guest", `${esc(b.guest_name)}<br>${esc(b.guest_email)}<br>${esc(b.guest_phone)}`],
  ];
  if (Number(b.total_paise) > 0) rows.push(["Total", fmtMoney(b.total_paise)]);
  if (b.special_requests) rows.push(["Requests", esc(b.special_requests)]);
  return `<table style="border-collapse:collapse;font:14px/1.5 Arial,sans-serif">${rows
    .map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#777;vertical-align:top">${k}</td><td style="padding:4px 0">${v}</td></tr>`)
    .join("")}</table>`;
}

function notify(kind: "arrival" | "inquiry" | "paid" | "paid_conflict", b: Booking): void {
  if (!RESEND_API_KEY || !EMAIL_FROM) return;
  background(sendNotifications(kind, b));
}

async function sendNotifications(kind: "arrival" | "inquiry" | "paid" | "paid_conflict", b: Booking): Promise<void> {
  const contact = await contactFooter();
  const summary = bookingSummaryHtml(b);
  const admin = SITE_URL ? `<p><a href="${esc(SITE_URL.replace(/\/+$/, ""))}/admin.html">Open the admin dashboard</a></p>` : "";
  const wrap = (body: string) => `<div style="font:14px/1.6 Arial,sans-serif;color:#222;max-width:560px">${body}</div>`;
  const guestWrap = (body: string) => wrap(body + contact);   // guests also get your contact details
  const tasks: Promise<void>[] = [];

  if (kind === "arrival") {
    tasks.push(sendEmail(OWNER_EMAIL, `Action needed: confirm booking ${b.ref}`, wrap(
      `<p><b>New pay-on-arrival request.</b> The dates are held until <b>${esc(new Date(String(b.hold_expires_at)).toUTCString())}</b>. Confirm it in the admin dashboard before then, or it will be released automatically.</p>${summary}${admin}`)));
    tasks.push(sendEmail(String(b.guest_email ?? ""), `${SITE_NAME}: booking request ${b.ref} received`, guestWrap(
      `<p>Hi ${esc(b.guest_name)},</p><p>Thank you — we've received your request and are holding these dates for you. We'll contact you shortly to confirm. Payment is due on arrival.</p>${summary}<p>— ${esc(SITE_NAME)}</p>`)));
  } else if (kind === "inquiry") {
    tasks.push(sendEmail(OWNER_EMAIL, `New inquiry ${b.ref}`, wrap(`<p><b>New price-on-request inquiry.</b> These dates are <u>not</u> blocked.</p>${summary}${admin}`)));
    tasks.push(sendEmail(String(b.guest_email ?? ""), `${SITE_NAME}: inquiry ${b.ref} received`, guestWrap(
      `<p>Hi ${esc(b.guest_name)},</p><p>Thank you for your inquiry. We'll reply with pricing and availability shortly.</p>${summary}<p>— ${esc(SITE_NAME)}</p>`)));
  } else if (kind === "paid") {
    tasks.push(sendEmail(OWNER_EMAIL, `Paid booking ${b.ref} — ${fmtMoney(b.total_paise)}`, wrap(`<p><b>New confirmed booking, paid online.</b></p>${summary}${admin}`)));
    tasks.push(sendEmail(String(b.guest_email ?? ""), `${SITE_NAME}: booking ${b.ref} confirmed`, guestWrap(
      `<p>Hi ${esc(b.guest_name)},</p><p>Your booking is confirmed and paid in full. Your invoice number is <b>${esc(b.invoice_no)}</b>; you can download the invoice from the confirmation screen.</p>${summary}<p>We look forward to hosting you!<br>— ${esc(SITE_NAME)}</p>`)));
  } else {
    tasks.push(sendEmail(OWNER_EMAIL, `URGENT: payment received but dates unavailable — ${b.ref}`, wrap(
      `<p><b>A guest paid after their hold expired and the dates were taken by someone else.</b> Please contact them to rebook or refund in Razorpay.</p>${summary}${admin}`)));
    tasks.push(sendEmail(String(b.guest_email ?? ""), `${SITE_NAME}: we've received your payment (${b.ref})`, guestWrap(
      `<p>Hi ${esc(b.guest_name)},</p><p>We've received your payment, but your reservation timed out before it completed and the room was booked meanwhile. We're sorry — we'll contact you very soon to offer other dates or a full refund.</p>${summary}<p>— ${esc(SITE_NAME)}</p>`)));
  }
  await Promise.all(tasks);
}

// ---------------------------------------------------------------------
//  Routes
// ---------------------------------------------------------------------
async function handleCreate(req: Request, body: Record<string, unknown>) {
  requireConfig(["SUPABASE_URL", SUPABASE_URL], ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY]);

  if (str(body.company, 200) !== "") throw new ClientError("invalid_request");   // honeypot field — bots fill it
  const roomId = str(body.room_id, 40, true);
  const checkIn = str(body.check_in, 10, true);
  const checkOut = str(body.check_out, 10, true);
  const mode = str(body.mode, 10, true);
  const name = str(body.name, 100, true);
  const email = str(body.email, 254, true).toLowerCase();
  const phone = str(body.phone, 20, true);
  const requests = str(body.requests, 1000);
  const units = int(body.units, 1, 99);
  const guests = int(body.guests, 1, 500);
  if (!ROOM_RE.test(roomId) || !DATE_RE.test(checkIn) || !DATE_RE.test(checkOut)) throw new ClientError("invalid_request");
  if (!["online", "arrival"].includes(mode)) throw new ClientError("invalid_mode", 422);
  if (!EMAIL_RE.test(email) || !PHONE_RE.test(phone)) throw new ClientError("invalid_details", 422);

  const ip = clientIp(req);
  if (!(await turnstilePassed(str(body.captcha, 2048), ip))) throw new ClientError("captcha_failed", 403);
  const ipHash = ip ? (await sha256Hex(`${IP_HASH_SALT || SERVICE_KEY.slice(-24)}|${ip}`)).slice(0, 32) : null;

  const booking = await rpc<Booking>("create_booking", {
    p_room_id: roomId, p_check_in: checkIn, p_check_out: checkOut, p_units: units, p_guests: guests,
    p_name: name, p_email: email, p_phone: phone, p_requests: requests || null, p_mode: mode,
    p_ip_hash: ipHash, p_admin: false,
  });

  if (booking.source === "online") {
    requireConfig(["RAZORPAY_KEY_ID", RZP_KEY_ID], ["RAZORPAY_KEY_SECRET", RZP_KEY_SECRET]);
    let order;
    try {
      order = await razorpayCreateOrder(Number(booking.total_paise), booking.ref, { booking_id: booking.id, booking_ref: booking.ref });
      await rpc("set_razorpay_order", { p_booking_id: booking.id, p_order_id: order.id });
    } catch (e) {
      await rpc("release_hold", { p_booking_id: booking.id }).catch(() => {});
      throw e;
    }
    return {
      booking: guestView({ ...booking, razorpay_order_id: order.id }),
      payment: { key_id: RZP_KEY_ID, order_id: order.id, amount: order.amount, currency: order.currency },
    };
  }

  notify(booking.source === "inquiry" ? "inquiry" : "arrival", booking);
  return { booking: guestView(booking) };
}

async function handleVerify(body: Record<string, unknown>) {
  requireConfig(["SUPABASE_URL", SUPABASE_URL], ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY], ["RAZORPAY_KEY_SECRET", RZP_KEY_SECRET]);
  const orderId = str(body.razorpay_order_id, 64, true);
  const paymentId = str(body.razorpay_payment_id, 64, true);
  const signature = str(body.razorpay_signature, 128, true);
  if (!/^order_[A-Za-z0-9]+$/.test(orderId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId) || !/^[a-f0-9]{64}$/.test(signature)) {
    throw new ClientError("invalid_signature", 400);
  }
  const expected = await hmacSha256Hex(RZP_KEY_SECRET, `${orderId}|${paymentId}`);
  if (!timingSafeEqual(expected, signature)) throw new ClientError("invalid_signature", 400);

  const booking = await rpc<Booking>("confirm_payment", { p_order_id: orderId, p_payment_id: paymentId, p_amount_paise: null });
  if (booking.newly_paid) notify(booking.status === "confirmed" ? "paid" : "paid_conflict", booking);
  return { booking: guestView(booking) };
}

async function handleWebhook(req: Request, headers: Record<string, string>): Promise<Response> {
  requireConfig(["SUPABASE_URL", SUPABASE_URL], ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY], ["RAZORPAY_WEBHOOK_SECRET", RZP_WEBHOOK_SECRET]);
  const raw = await readBody(req);
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  const expected = await hmacSha256Hex(RZP_WEBHOOK_SECRET, raw);
  if (!timingSafeEqual(expected, signature)) return json({ error: "invalid_signature" }, 400, headers);

  const event = parseJson(raw);
  const type = String(event.event ?? "");
  if (type !== "payment.captured" && type !== "order.paid") return json({ ok: true, ignored: type }, 200, headers);

  // deno-lint-ignore no-explicit-any
  const payment = (event as any).payload?.payment?.entity ?? {};
  const orderId = String(payment.order_id ?? "");
  const paymentId = String(payment.id ?? "");
  if (!orderId || !paymentId) return json({ ok: true, ignored: "no_order" }, 200, headers);

  try {
    const booking = await rpc<Booking>("confirm_payment", {
      p_order_id: orderId, p_payment_id: paymentId, p_amount_paise: Number(payment.amount ?? 0) || null,
    });
    if (booking.newly_paid) notify(booking.status === "confirmed" ? "paid" : "paid_conflict", booking);
  } catch (e) {
    if (e instanceof ClientError && e.code === "booking_not_found") return json({ ok: true, ignored: "unknown_order" }, 200, headers);
    throw e;   // 500 → Razorpay retries later
  }
  return json({ ok: true }, 200, headers);
}

Deno.serve(async (req: Request): Promise<Response> => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);

  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  try {
    if (route === "webhook") return await handleWebhook(req, headers);
    if (!originAllowed(req)) return json({ error: "forbidden_origin" }, 403, headers);
    const body = parseJson(await readBody(req));
    if (route === "create") return json(await handleCreate(req, body), 200, headers);
    if (route === "verify") return json(await handleVerify(body), 200, headers);
    return json({ error: "not_found" }, 404, headers);
  } catch (e) {
    if (e instanceof ClientError) return json({ error: e.code }, e.status, headers);
    console.error("booking-api error:", e instanceof Error ? e.message : e);
    return json({ error: "server_error" }, 500, headers);
  }
});
