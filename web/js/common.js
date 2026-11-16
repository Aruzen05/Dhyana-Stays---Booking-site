/* Shared helpers for the public site and the admin dashboard. No dependencies. */
(function () {
  "use strict";
  const CFG = window.SITE_CONFIG || {};
  const SB = CFG.supabase || {};

  // ------------------------------------------------------------------
  //  Escaping — every piece of data put into HTML goes through esc().
  // ------------------------------------------------------------------
  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
  const esc = (v) => String(v ?? "").replace(/[&<>"'`]/g, (c) => ESC_MAP[c]);

  // Only https:// links, blob: previews and local image paths are allowed as URLs.
  function safeUrl(u, fallback = "") {
    const s = String(u ?? "").trim();
    if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
    if (/^blob:https?:\/\/[^\s"'<>]+$/i.test(s)) return s;
    if (/^(images|img|assets)\/[\w./-]+$/i.test(s) && !s.includes("..")) return s;
    return fallback;
  }
  const cssUrl = (u) => { const s = safeUrl(u); return s ? `url("${s.replace(/["\\\n\r]/g, "")}")` : "none"; };

  // ------------------------------------------------------------------
  //  Icons: simple line drawings in the text colour (no emoji, so they look
  //  the same on every device). icon("pin") → inline <svg>. Unknown names → "".
  // ------------------------------------------------------------------
  const ICONS = {
    pin: '<path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
    phone: '<path d="M6.5 3.5h3l1.5 4-2 1.3a11 11 0 0 0 6.2 6.2l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z"/>',
    mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.6 7 8.4 6.2L20.4 7"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8.2 12.4 2.7 2.7 5-5.4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
    alert: '<path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
    play: '<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l9.6-6.2a.8.8 0 0 0 0-1.4L9.2 5.1A.8.8 0 0 0 8 5.8z" fill="currentColor"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    // highlights (config.js → highlights[].icon)
    calm: '<path d="M12 6.5c1.8 1.9 2.6 4 2.6 6.2S13.8 17 12 18.5c-1.8-1.5-2.6-3.6-2.6-5.8S10.2 8.4 12 6.5z"/><path d="M9.6 10.2C7.4 9.8 5.4 10.5 3.5 12c1.6 3.6 4.7 5.8 8.5 6.5"/><path d="M14.4 10.2c2.2-.4 4.2.3 6.1 1.8-1.6 3.6-4.7 5.8-8.5 6.5"/>',
    nature: '<path d="M5 19.5C5 11 10 5.5 19.5 4.5 19.5 14 14 19.5 5 19.5z"/><path d="M5 19.5 13.5 11"/>',
    home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.8 9.4V20h12.4V9.4"/><path d="M10 20v-5.2h4V20"/>',
    support: '<path d="M4.5 14.5V12a7.5 7.5 0 0 1 15 0v2.5"/><rect x="3" y="13.5" width="4" height="6" rx="1.6"/><rect x="17" y="13.5" width="4" height="6" rx="1.6"/><path d="M19 19.5c0 1.2-1.6 2-4 2h-2"/>',
  };
  const icon = (name, cls = "icon") => (ICONS[name]
    ? `<svg class="${esc(cls)}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`
    : "");

  // ------------------------------------------------------------------
  //  Dates. 'YYYY-MM-DD' strings are calendar dates: all maths is done in
  //  UTC so a guest's own timezone can never shift a day.
  // ------------------------------------------------------------------
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const MON = MONTHS.map((m) => m.slice(0, 3));
  const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  function parseYMD(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ""));
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function ymd(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10); }
  function utcMs(s) { const p = parseYMD(s); return p ? Date.UTC(p.y, p.m - 1, p.d) : NaN; }
  function addDays(s, n) { const p = parseYMD(s); return ymd(p.y, p.m, p.d + n); }
  function nightsBetween(a, b) { return Math.round((utcMs(b) - utcMs(a)) / 864e5); }
  function dayOfWeek(s) { return new Date(utcMs(s)).getUTCDay(); }
  function todayIn(tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz || CFG.timezone || "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
      const get = (t) => parts.find((p) => p.type === t).value;
      return `${get("year")}-${get("month")}-${get("day")}`;
    } catch {
      const d = new Date();
      return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
  }
  function fmtDate(s, long = false) {
    const p = parseYMD(s);
    if (!p) return "—";
    return `${p.d} ${long ? MONTHS[p.m - 1] : MON[p.m - 1]} ${p.y}`;
  }
  function fmtDateTime(iso) {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("en-IN", { timeZone: CFG.timezone || "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
    } catch { return new Date(iso).toLocaleString(); }
  }
  function timeLeft(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (!(ms > 0)) return "expired";
    const h = Math.floor(ms / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
  }

  // ------------------------------------------------------------------
  //  Money (database stores paise)
  // ------------------------------------------------------------------
  function inr(paise) {
    const n = Number(paise || 0) / 100;
    return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  const inrRupees = (r) => inr(Number(r || 0) * 100);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

  // ------------------------------------------------------------------
  //  Supabase API
  // ------------------------------------------------------------------
  class ApiError extends Error {
    constructor(code, status, detail) { super(code); this.code = code; this.status = status; this.detail = detail; }
  }
  const configured = () => /^https:\/\/.+/.test(SB.url || "") && !!SB.key && !/YOUR-/.test(SB.url + SB.key);

  function baseHeaders(token) {
    const h = { apikey: SB.key, "Content-Type": "application/json" };
    const bearer = token || (SB.key && !String(SB.key).startsWith("sb_") ? SB.key : null);
    if (bearer) h.Authorization = "Bearer " + bearer;
    return h;
  }

  async function request(url, { method = "GET", body, token, headers = {}, prefer, raw = false } = {}) {
    const h = baseHeaders(token);
    if (raw) delete h["Content-Type"];
    Object.assign(h, headers);
    if (prefer) h.Prefer = prefer;
    let res;
    try {
      res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    } catch {
      throw new ApiError("network", 0);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const d = data && typeof data === "object" ? data : {};
      const code = d.error_code || d.error || d.message || d.msg || `http_${res.status}`;
      throw new ApiError(String(code), res.status, d);
    }
    return data;
  }
  const rest = (path, opts) => request(`${SB.url}/rest/v1/${path}`, opts);
  const rpc = (fn, args, token) => request(`${SB.url}/rest/v1/rpc/${fn}`, { method: "POST", body: args || {}, token });
  const bookingApi = (route, body) => request(`${SB.url}/functions/v1/booking-api/${route}`, { method: "POST", body });

  const MESSAGES = {
    not_available: "Sorry — those dates have just been booked. Please choose other dates.",
    date_in_past: "Check-in can't be in the past.",
    invalid_dates: "Please choose a check-out date after your check-in date.",
    too_many_nights: "That stay is longer than we accept online — please contact us.",
    too_far_ahead: "We don't take bookings that far ahead yet — please contact us.",
    invalid_units: "Please choose a valid number of rooms.",
    too_many_guests: "That's more guests than this room allows. Add a room or choose a larger one.",
    name_required: "Please enter your name.",
    contact_required: "Please enter your email and phone number.",
    invalid_details: "Please check your email address and phone number.",
    invalid_request: "Please check the form and try again.",
    arrival_disabled: "Pay on arrival isn't available right now — please pay online.",
    too_many_holds: "You already have bookings waiting for confirmation. Please contact us.",
    rate_limited: "Too many attempts. Please wait a little and try again.",
    captcha_failed: "Please complete the “I'm human” check and try again.",
    room_not_found: "That room is no longer available.",
    invalid_signature: "We couldn't verify the payment. If money was taken, please contact us with your payment ID.",
    not_configured: "Online booking isn't fully set up yet. Please contact us directly.",
    forbidden_origin: "Bookings aren't accepted from this web address.",
    network: "We can't reach the server. Check your internet connection and try again.",
    server_error: "Something went wrong on our side. Please try again, or contact us.",
    // admin
    not_authorised: "This account isn't an admin.",
    dates_taken: "Those dates have been booked by someone else in the meantime.",
    has_payment_records: "Bookings with payments can't be deleted — cancel them instead.",
    already_paid: "This booking is already marked as paid.",
    confirm_first: "Confirm the booking before recording a payment.",
    no_price: "This booking has no price, so it can't be invoiced.",
    invalid_transition: "That status change isn't allowed.",
    inquiry_has_no_dates: "Inquiries don't hold dates — use “Add booking” for this guest instead.",
    not_paid: "This booking isn't marked as paid.",
    invalid_credentials: "Wrong email or password.",
    invalid_grant: "Wrong email or password.",
    over_email_send_rate_limit: "Too many emails sent. Please wait a few minutes.",
    weak_password: "Choose a stronger password (at least 10 characters, mixing words and numbers).",
    same_password: "The new password must be different from the old one.",
    media_too_big: "Photos and videos for one stay can add up to 500 MB at most. Remove something first.",
    file_too_big_for_plan: "That file is bigger than your Supabase plan accepts. The Free plan takes files up to 50 MB; on Pro, raise Storage → Settings → Global file size limit to 500 MB.",
    invalid_mime_type: "That file type isn't accepted. Use JPEG, PNG or WebP photos, or MP4, WebM or MOV videos.",
    "23505": "That ID is already in use.",
    "23503": "This room has bookings, so it can't be deleted — untick “Show on website” to hide it instead.",
    "23514": "Some values aren't allowed — please check the form (e.g. GSTIN format, email or phone).",
    "22P02": "Some values aren't in the right format — please check the form.",
    "42501": "You don't have permission to do that.",
  };
  function friendly(e) {
    const code = e && (e.code || e.message);
    if (MESSAGES[code]) return MESSAGES[code];
    if (e && e.detail && MESSAGES[e.detail.code]) return MESSAGES[e.detail.code];
    if (e && /JWT|token/i.test(String(code))) return "Your session has expired. Please log in again.";
    return MESSAGES.server_error;
  }

  // ------------------------------------------------------------------
  //  Theme + fonts from config
  // ------------------------------------------------------------------
  function applyTheme() {
    const t = CFG.theme || {};
    const root = document.documentElement.style;
    const map = { primary: "--c-primary", primaryDark: "--c-primary-dark", accent: "--c-accent", ink: "--c-ink", inkSoft: "--c-ink-soft",
                  muted: "--c-muted", paper: "--c-paper", cream: "--c-cream", sand: "--c-sand", dark: "--c-dark" };
    for (const [k, v] of Object.entries(map)) if (/^#[0-9a-f]{3,8}$/i.test(t[k] || "")) root.setProperty(v, t[k]);
    const okFont = (f) => /^[A-Za-z0-9 ]{2,40}$/.test(f || "");
    const fams = [];
    if (okFont(t.fontHeading)) { root.setProperty("--f-heading", `"${t.fontHeading}", Georgia, serif`); fams.push(`family=${t.fontHeading.replace(/ /g, "+")}:wght@600;700`); }
    if (okFont(t.fontBody)) { root.setProperty("--f-body", `"${t.fontBody}", "Segoe UI", system-ui, sans-serif`); fams.push(`family=${t.fontBody.replace(/ /g, "+")}:wght@400;500;600;700`); }
    if (fams.length) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `https://fonts.googleapis.com/css2?${fams.join("&")}&display=swap`;
      document.head.appendChild(link);
    }
  }

  const scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src; s.async = true;   // no crossOrigin: not every provider (e.g. Razorpay) sends CORS headers for its script
        s.onload = resolve;
        s.onerror = () => { delete scriptCache[src]; reject(new ApiError("network", 0)); };
        document.head.appendChild(s);
      });
    }
    return scriptCache[src];
  }

  // ------------------------------------------------------------------
  //  Contact details — managed in admin → Settings, loaded by each page.
  //  config.js only holds an emergency fallback for when the DB is down.
  // ------------------------------------------------------------------
  let contactData = null;
  function setContact(s) {
    contactData = s ? {
      phones: (s.contact_phones || []).filter(Boolean),
      whatsapp: s.contact_whatsapp || "",
      emails: (s.contact_emails || []).filter(Boolean),
      address: (s.contact_address || []).filter(Boolean),
      mapUrl: s.contact_map_url || "",
      hours: s.contact_hours || "",
    } : null;
  }
  function contact() {
    if (contactData) return contactData;
    const f = CFG.contactFallback || {};
    return { phones: f.phone ? [f.phone] : [], whatsapp: "", emails: f.email ? [f.email] : [], address: [], mapUrl: "", hours: "", fallback: true };
  }
  const telHref = (n) => "tel:" + String(n || "").replace(/[^\d+]/g, "");
  function locationLine(loc) {
    if (!loc) return "";
    return [loc.name, loc.area_label].filter(Boolean).join(" · ");
  }

  // ------------------------------------------------------------------
  //  Invoice / booking summary (rendered to PDF in the browser)
  // ------------------------------------------------------------------
  function groupNights(q) {
    const groups = [];
    for (const n of q.nightly || []) {
      const g = groups.find((x) => x.tariff === n.tariff && x.gst_rate === n.gst_rate);
      if (g) g.count++; else groups.push({ tariff: n.tariff, gst_rate: n.gst_rate, count: 1 });
    }
    return groups;
  }

  function invoiceHTML(b) {
    const brand = CFG.brand || {}, c = contact();
    const q = b.quote || {};
    const loc = q.location || null;
    const units = Number(b.num_units || 1);
    const isInvoice = b.payment_status === "paid" && !!b.invoice_no;
    const gstOn = !!q.gst_enabled && !!q.gstin;
    const title = isInvoice ? (gstOn ? "TAX INVOICE" : "PAYMENT RECEIPT") : "BOOKING SUMMARY";
    const groups = groupNights(q);
    const td = "padding:10px 16px;border-bottom:1px solid #e6e1d6;font-size:13px";
    const nights = nightsBetween(b.check_in, b.check_out);

    let rows = groups.map((g) => `<tr>
        <td style="${td}">${esc(b.room_name)} — ${plural(g.count, "night")}${units > 1 ? ` × ${units} rooms` : ""} @ ${inrRupees(g.tariff)}${gstOn ? `<br><span style="color:#888;font-size:11px">SAC 996311 · GST ${g.gst_rate}%</span>` : ""}</td>
        <td style="${td};text-align:right">${inr(g.count * g.tariff * units * 100)}</td></tr>`).join("");
    if (!groups.length) rows = `<tr><td style="${td}">${esc(b.room_name)} — ${plural(nights, "night")}</td><td style="${td};text-align:right">${b.total_paise ? inr(b.subtotal_paise) : "Price on request"}</td></tr>`;

    let tax = "";
    if (gstOn) {
      for (const rate of [...new Set(groups.map((g) => g.gst_rate))].filter((r) => r > 0)) {
        const g = groups.filter((x) => x.gst_rate === rate).reduce((s, x) => s + x.count * x.tariff * rate * units, 0);
        const half = Math.floor(g / 2);
        tax += `<tr><td style="${td};color:#666">CGST @ ${rate / 2}%</td><td style="${td};text-align:right;color:#666">${inr(half)}</td></tr>
                <tr><td style="${td};color:#666">SGST @ ${rate / 2}%</td><td style="${td};text-align:right;color:#666">${inr(g - half)}</td></tr>`;
      }
      if (!tax) tax = `<tr><td style="${td};color:#666">GST</td><td style="${td};text-align:right;color:#666">Exempt (tariff up to ₹1,000)</td></tr>`;
    }

    const paidLine = b.payment_status === "paid"
      ? `Paid ${b.payment_method === "razorpay" ? "online via Razorpay" : "by " + esc(b.payment_method || "—")}${b.paid_at ? " on " + esc(fmtDateTime(b.paid_at)) : ""}${b.razorpay_payment_id ? `<br>Payment ID: ${esc(b.razorpay_payment_id)}` : ""}`
      : b.status === "hold" && b.source === "arrival"
        ? `Payment due on arrival. Dates held until ${esc(fmtDateTime(b.hold_expires_at))} pending our confirmation.`
        : b.source === "inquiry" ? "Inquiry — no payment requested yet." : "Payment due on arrival.";

    const box = "background:#f7f4ee;border-radius:8px;padding:16px 18px";
    const label = "font-size:10px;font-weight:700;color:#888;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:8px";
    return `<div style="font-family:Arial,Helvetica,sans-serif;background:#fff;width:794px;color:#222;padding:40px 48px;box-sizing:border-box">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid ${esc((CFG.theme || {}).primary || "#2F6B4F")};padding-bottom:18px">
        <div>
          <div style="font-size:24px;font-weight:800">${esc(q.legal_name || brand.name || "")}</div>
          <div style="font-size:12px;color:#555;margin-top:6px;line-height:1.6">${c.address.map(esc).join("<br>")}${c.address.length ? "<br>" : ""}${[c.phones[0], c.emails[0]].filter(Boolean).map(esc).join(" · ")}</div>
          ${gstOn ? `<div style="font-size:12px;margin-top:6px"><b>GSTIN:</b> ${esc(q.gstin)}</div>` : ""}
        </div>
        <div style="text-align:right">
          <div style="font-size:20px;font-weight:800;letter-spacing:2px">${title}</div>
          <div style="font-size:12px;color:#555;margin-top:6px;line-height:1.7">
            ${isInvoice ? `Invoice no: <b>${esc(b.invoice_no)}</b><br>Date: ${esc(fmtDate(b.invoice_date))}<br>` : ""}
            Booking ref: <b>${esc(b.ref)}</b>${gstOn && loc && loc.state ? `<br>Place of supply: ${esc(loc.state)}` : ""}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:16px;margin:22px 0">
        <div style="${box};flex:1"><div style="${label}">Billed to</div>
          <div style="font-size:15px;font-weight:700">${esc(b.guest_name)}</div>
          <div style="font-size:12px;color:#555;margin-top:4px;line-height:1.6">${esc(b.guest_email || "")}<br>${esc(b.guest_phone || "")}</div></div>
        <div style="${box};flex:1"><div style="${label}">Stay</div>
          <div style="font-size:12px;line-height:1.8">${esc(b.room_name)}${units > 1 ? ` × ${units}` : ""}<br>
          ${loc ? `<b>${esc(loc.name)}</b>${(loc.address_lines || []).length ? " — " + loc.address_lines.map(esc).join(", ") : ""}${loc.state ? ", " + esc(loc.state) : ""}<br>` : ""}
          ${esc(fmtDate(b.check_in, true))} → ${esc(fmtDate(b.check_out, true))} (${plural(nights, "night")})<br>${plural(Number(b.num_guests || 0), "guest")}</div></div>
      </div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e6e1d6">
        <thead><tr style="background:#222;color:#fff"><th style="padding:10px 16px;text-align:left;font-size:11px;letter-spacing:1px">DESCRIPTION</th><th style="padding:10px 16px;text-align:right;font-size:11px;letter-spacing:1px">AMOUNT</th></tr></thead>
        <tbody>${rows}${gstOn && groups.length ? `<tr><td style="${td};font-weight:700">Taxable value</td><td style="${td};text-align:right;font-weight:700">${inr(b.subtotal_paise)}</td></tr>` : ""}${tax}</tbody>
        <tfoot><tr style="background:#f7f4ee"><td style="padding:12px 16px;font-size:15px;font-weight:800">${b.payment_status === "paid" ? "TOTAL PAID" : "TOTAL"}</td><td style="padding:12px 16px;font-size:15px;font-weight:800;text-align:right">${b.total_paise ? inr(b.total_paise) : "—"}</td></tr></tfoot>
      </table>
      <div style="${box};margin-top:18px;font-size:12px;line-height:1.7">${paidLine}</div>
      ${!gstOn && isInvoice ? `<div style="font-size:11px;color:#888;margin-top:10px">Supplier not registered under GST — no GST charged.</div>` : ""}
      <div style="display:flex;justify-content:space-between;margin-top:28px;font-size:11px;color:#888">
        <div>Thank you for staying with ${esc(brand.name || "us")}.</div><div>Computer-generated document · no signature required</div>
      </div>
    </div>`;
  }

  async function downloadInvoice(b) {
    await Promise.all([
      loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"),
      loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"),
    ]);
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;background:#fff";
    wrap.innerHTML = invoiceHTML(b);
    document.body.appendChild(wrap);
    try {
      const canvas = await window.html2canvas(wrap.firstElementChild, { scale: 2, backgroundColor: "#ffffff", logging: false, windowWidth: 794 });
      const { jsPDF } = window.jspdf;
      // Always a normal A4 page. (Sizing the page to the receipt made it wider than tall;
      // jsPDF then turned the "portrait" page sideways and cut off the right-hand side.)
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
      let w = pageW, h = (canvas.height * pageW) / canvas.width;
      if (h > pageH) { h = pageH; w = (canvas.width * pageH) / canvas.height; }   // a very long receipt shrinks to fit one page
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", (pageW - w) / 2, 0, w, h);
      const slug = String((CFG.brand || {}).fileSlug || "Stay").replace(/[^A-Za-z0-9]/g, "") || "Stay";
      const id = String(b.invoice_no || b.ref).replace(/[^A-Za-z0-9-]/g, "-");
      pdf.save(`${slug}-${b.invoice_no ? "Invoice" : "Booking"}-${id}.pdf`);
    } finally {
      wrap.remove();
    }
  }

  window.Stay = {
    CFG, esc, safeUrl, cssUrl, icon,
    MONTHS, DOW, parseYMD, ymd, addDays, nightsBetween, dayOfWeek, todayIn, fmtDate, fmtDateTime, timeLeft,
    inr, inrRupees, plural,
    ApiError, configured, request, rest, rpc, bookingApi, friendly,
    applyTheme, loadScript, groupNights, invoiceHTML, downloadInvoice,
    setContact, contact, telHref, locationLine,
  };
})();
