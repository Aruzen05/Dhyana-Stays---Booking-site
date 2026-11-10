/* Admin dashboard. Login = Supabase Auth; access = public.admins + RLS (see setup.sql). */
(function () {
  "use strict";
  const S = window.Stay;
  const CFG = S.CFG;
  const SB = CFG.supabase || {};
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
  const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  const SESSION_KEY = "stay_admin_session";
  const TZ = CFG.timezone || "Asia/Kolkata";
  // Indian states / UTs with their GST state codes (the first two digits of a GSTIN).
  const STATES = [
    ["Andaman and Nicobar Islands", "35"], ["Andhra Pradesh", "37"], ["Arunachal Pradesh", "12"], ["Assam", "18"], ["Bihar", "10"],
    ["Chandigarh", "04"], ["Chhattisgarh", "22"], ["Dadra and Nagar Haveli and Daman and Diu", "26"], ["Delhi", "07"], ["Goa", "30"],
    ["Gujarat", "24"], ["Haryana", "06"], ["Himachal Pradesh", "02"], ["Jammu and Kashmir", "01"], ["Jharkhand", "20"], ["Karnataka", "29"],
    ["Kerala", "32"], ["Ladakh", "38"], ["Lakshadweep", "31"], ["Madhya Pradesh", "23"], ["Maharashtra", "27"], ["Manipur", "14"],
    ["Meghalaya", "17"], ["Mizoram", "15"], ["Nagaland", "13"], ["Odisha", "21"], ["Puducherry", "34"], ["Punjab", "03"], ["Rajasthan", "08"],
    ["Sikkim", "11"], ["Tamil Nadu", "33"], ["Telangana", "36"], ["Tripura", "16"], ["Uttar Pradesh", "09"], ["Uttarakhand", "05"], ["West Bengal", "19"],
  ];
  const stateCode = (name) => (STATES.find(([n]) => n === name) || [])[1] || "";
  const lines = (v) => String(v || "").split("\n").map((s) => s.trim()).filter(Boolean);

  // ==================================================================
  //  Auth (Supabase GoTrue REST — session kept for this browser tab only)
  // ==================================================================
  let session = null;
  const auth = (path, opts) => S.request(`${SB.url}/auth/v1/${path}`, opts);

  function saveSession(d) {
    session = d ? {
      access_token: d.access_token, refresh_token: d.refresh_token,
      expires_at: Number(d.expires_at) || Math.floor(Date.now() / 1000) + Number(d.expires_in || 3600),
      user: d.user ? { id: d.user.id, email: d.user.email } : session?.user,
    } : null;
    try { session ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)) : sessionStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
  }
  function restoreSession() { try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch { session = null; } }

  let refreshing = null;
  async function refresh() {
    if (!session?.refresh_token) throw new S.ApiError("session_expired", 401);
    refreshing = refreshing || auth("token?grant_type=refresh_token", { method: "POST", body: { refresh_token: session.refresh_token } })
      .then(saveSession).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function accessToken() {
    if (!session) throw new S.ApiError("session_expired", 401);
    if (session.expires_at - 60 < Date.now() / 1000) await refresh();
    return session.access_token;
  }
  async function authed(call) {
    try {
      return await call(await accessToken());
    } catch (e) {
      if (e.status !== 401 && !/JWT/i.test(e.code)) throw e;
      try { await refresh(); } catch { expired(); throw e; }
      return call(session.access_token);
    }
  }
  const aRest = (path, opts = {}) => authed((t) => S.rest(path, { ...opts, token: t }));
  const aRpc = (fn, args) => authed((t) => S.rpc(fn, args, t));

  function expired() {
    saveSession(null);
    showAuth("login");
    showMsg("#login-err", "Your session has expired. Please log in again.", "bad");
  }

  async function isAdmin() {
    const rows = await aRest("admins?select=user_id");
    return Array.isArray(rows) && rows.length === 1;
  }

  // ==================================================================
  //  Views
  // ==================================================================
  function showAuth(view) {
    $("#app").hidden = true;
    $("#auth").hidden = false;
    ["login", "forgot", "newpw"].forEach((v) => { $(`#f-${v}`).hidden = v !== view; });
    $("#auth-sub").textContent = { login: "Owner dashboard", forgot: "Reset password", newpw: "Set a new password" }[view];
    $$(".auth .msg").forEach((m) => { m.hidden = true; });
    setTimeout(() => { const f = $(`#f-${view} input`); if (f) f.focus(); }, 20);
  }
  async function showApp() {
    $("#auth").hidden = true;
    $("#app").hidden = false;
    $("#who").textContent = `Signed in as ${session?.user?.email || ""}`;
    // Contact details are needed for invoice PDFs downloaded from the Bookings tab.
    aRest("settings?select=contact_phones,contact_whatsapp,contact_emails,contact_address,contact_map_url,contact_hours")
      .then((rows) => S.setContact(rows[0])).catch(() => {});
    switchTab("bookings");
  }
  function showMsg(sel, text, kind = "") {
    const el = $(sel);
    el.textContent = text;
    el.className = `msg${kind ? " msg-" + kind : ""}`;
    el.hidden = !text;
  }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || "Working…"; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }
  let toastTimer;
  function toast(text, bad = false) {
    const t = $("#toast");
    t.textContent = text;
    t.className = `toast${bad ? " toast-bad" : ""}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
  }

  // ---------- auth forms ----------
  async function doLogin(e) {
    e.preventDefault();
    const email = $("#login-email").value.trim(), pw = $("#login-pw").value;
    if (!EMAIL_RE.test(email) || !pw) { showMsg("#login-err", "Enter your email and password.", "bad"); return; }
    const btn = $("#login-btn");
    busy(btn, true, "Checking…");
    showMsg("#login-err", "");
    try {
      saveSession(await auth("token?grant_type=password", { method: "POST", body: { email, password: pw } }));
      if (!(await isAdmin())) {
        await signOut(false);
        showMsg("#login-err", "This account isn't set up as an admin. See README → “Make yourself the admin”.", "bad");
      } else {
        $("#login-pw").value = "";
        await showApp();
      }
    } catch (err) {
      saveSession(null);
      showMsg("#login-err", S.friendly(err), "bad");
    }
    busy(btn, false);
  }

  async function doForgot(e) {
    e.preventDefault();
    const email = $("#forgot-email").value.trim();
    if (!EMAIL_RE.test(email)) { showMsg("#forgot-msg", "Enter a valid email.", "bad"); return; }
    const btn = $("#forgot-btn");
    busy(btn, true, "Sending…");
    try {
      const back = encodeURIComponent(location.origin + location.pathname);
      await auth(`recover?redirect_to=${back}`, { method: "POST", body: { email } });
    } catch (err) {
      if (err.code === "over_email_send_rate_limit") { showMsg("#forgot-msg", S.friendly(err), "bad"); busy(btn, false); return; }
    }
    showMsg("#forgot-msg", "If that email belongs to an admin, a reset link is on its way. Check your inbox (and spam).", "ok");
    busy(btn, false);
  }

  async function doNewPassword(e) {
    e.preventDefault();
    const a = $("#new-pw").value, b = $("#new-pw2").value;
    if (a.length < 10) { showMsg("#newpw-msg", "Use at least 10 characters.", "bad"); return; }
    if (a !== b) { showMsg("#newpw-msg", "The two passwords don't match.", "bad"); return; }
    const btn = $("#newpw-btn");
    busy(btn, true, "Saving…");
    try {
      await authed((t) => auth("user", { method: "PUT", body: { password: a }, token: t }));
      $("#new-pw").value = $("#new-pw2").value = "";
      if (await isAdmin()) { toast("Password updated."); await showApp(); }
      else { await signOut(false); showAuth("login"); showMsg("#login-err", "Password updated, but this account isn't an admin.", "bad"); }
    } catch (err) {
      showMsg("#newpw-msg", S.friendly(err), "bad");
    }
    busy(btn, false);
  }

  async function signOut(show = true) {
    const token = session?.access_token;
    saveSession(null);
    if (token) auth("logout", { method: "POST", token }).catch(() => {});
    if (show) showAuth("login");
  }

  async function handleAuthRedirect() {
    if (!location.hash || location.hash.length < 2) return false;
    const p = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, "", location.pathname + location.search);
    if (p.get("error")) {
      showAuth("forgot");
      showMsg("#forgot-msg", p.get("error_code") === "otp_expired" ? "That link has expired. Send a new one." : (p.get("error_description") || "That link didn't work. Send a new one."), "bad");
      return true;
    }
    if (p.get("access_token") && p.get("type") === "recovery") {
      saveSession({ access_token: p.get("access_token"), refresh_token: p.get("refresh_token"), expires_at: p.get("expires_at"), expires_in: p.get("expires_in") });
      try { const u = await auth("user", { token: session.access_token }); session.user = { id: u.id, email: u.email }; saveSession(session); } catch { /* shown on save */ }
      showAuth("newpw");
      return true;
    }
    return false;
  }

  // ==================================================================
  //  Tabs
  // ==================================================================
  function switchTab(tab) {
    $$(".tab").forEach((t) => { const on = t.dataset.tab === tab; t.classList.toggle("active", on); t.setAttribute("aria-selected", String(on)); });
    ["bookings", "rooms", "locations", "settings"].forEach((p) => { $(`#panel-${p}`).hidden = p !== tab; });
    if (tab === "bookings") loadBookings();
    if (tab === "rooms") loadRooms();
    if (tab === "locations") loadLocations();
    if (tab === "settings") loadSettings();
  }

  // ==================================================================
  //  Bookings
  // ==================================================================
  const B = { rows: [], filter: null, pay: "all", loc: "all", sort: "created", q: "", offset: 0, page: 300, more: false, current: null, loading: false };
  const today = () => S.todayIn(TZ);
  const holdLive = (r) => r.status === "hold" && new Date(r.hold_expires_at).getTime() > Date.now();
  // Online holds resolve themselves (paid or expire in minutes); only arrival requests need the owner.
  const needsAction = (r) => (holdLive(r) && r.source !== "online") || r.needs_attention;
  const isUpcoming = (r) => r.status === "confirmed" && r.check_out >= today();
  const isPast = (r) => r.status === "completed" || (r.status === "confirmed" && r.check_out < today());
  const effectiveStatus = (r) => (r.status === "hold" && !holdLive(r) ? "expired" : r.status);

  const CHIPS = [
    ["action", "Needs action", needsAction],
    ["upcoming", "Upcoming", isUpcoming],
    ["inquiry", "Inquiries", (r) => r.status === "inquiry"],
    ["past", "Past stays", isPast],
    ["closed", "Cancelled / expired", (r) => ["cancelled", "expired"].includes(effectiveStatus(r))],
    ["all", "All", () => true],
  ];

  function tzMonth(iso) {
    try {
      const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit" }).formatToParts(new Date(iso));
      return `${p.find((x) => x.type === "year").value}-${p.find((x) => x.type === "month").value}`;
    } catch { return String(iso).slice(0, 7); }
  }

  async function loadBookings(append = false) {
    if (B.loading) return;
    B.loading = true;
    if (!append) { B.offset = 0; $("#bk-empty").textContent = "Loading bookings…"; }
    try {
      if (!append) await aRpc("admin_expire_holds", {}).catch(() => {});
      const rows = await aRest(`bookings?select=*&order=created_at.desc&limit=${B.page}&offset=${B.offset}`);
      B.rows = append ? B.rows.concat(rows) : rows;
      B.more = rows.length === B.page;
      B.offset += rows.length;
      if (B.filter === null) B.filter = B.rows.some(needsAction) ? "action" : "upcoming";
      renderBookings();
    } catch (e) {
      $("#bk-empty").textContent = S.friendly(e);
      $("#bk-empty").hidden = false;
      $("#bk-table").hidden = true;
    }
    B.loading = false;
  }

  function statusBadge(r) {
    const st = effectiveStatus(r);
    if (st === "hold") {
      const label = r.source === "online" ? "Payment pending" : "Awaiting your confirmation";
      return `<span class="badge b-warn">${label}</span><small class="sub">${S.esc(S.timeLeft(r.hold_expires_at))}</small>`;
    }
    const map = { confirmed: ["b-ok", "Confirmed"], completed: ["b-info", "Completed"], cancelled: ["b-bad", "Cancelled"], expired: ["b-grey", "Expired"], inquiry: ["b-info", "Inquiry"] };
    const [cls, label] = map[st] || ["b-grey", st];
    return `<span class="badge ${cls}">${label}</span>${r.needs_attention ? `<small class="sub sub-bad">needs attention</small>` : ""}`;
  }
  function payBadge(r) {
    if (r.payment_status === "paid") return `<span class="badge b-ok">Paid</span><small class="sub">${S.esc(r.payment_method === "razorpay" ? "online" : r.payment_method || "")}</small>`;
    if (r.payment_status === "refunded") return `<span class="badge b-grey">Refunded</span>`;
    if (r.source === "inquiry" || !r.total_paise) return `<span class="muted">—</span>`;
    if (["confirmed", "completed"].includes(r.status)) return `<span class="badge b-warn">Due on arrival</span>`;
    return `<span class="muted">Unpaid</span>`;
  }

  function filtered() {
    const chip = CHIPS.find((c) => c[0] === B.filter) || CHIPS[5];
    const q = B.q.toLowerCase();
    const digits = q.replace(/\D/g, "");
    let list = B.rows.filter((r) => chip[2](r)
      && (B.pay === "all" || r.payment_status === B.pay)
      && (B.loc === "all" || (r.location_id || "") === B.loc)
      && (!q || [r.guest_name, r.guest_email, r.ref, r.room_name, r.invoice_no].some((v) => String(v || "").toLowerCase().includes(q))
          || (digits.length >= 4 && String(r.guest_phone || "").replace(/\D/g, "").includes(digits))));
    if (B.sort === "checkin") list = list.slice().sort((a, b) => a.check_in.localeCompare(b.check_in));
    return list;
  }

  function renderBookings() {
    const t = today(), month = t.slice(0, 7), week = S.addDays(t, 7);
    const paidMonth = B.rows.filter((r) => r.payment_status === "paid" && r.paid_at && tzMonth(r.paid_at) === month).reduce((s, r) => s + Number(r.total_paise || 0), 0);
    const arriving = B.rows.filter((r) => r.status === "confirmed" && r.check_in >= t && r.check_in <= week).length;
    $("#stats").innerHTML = [
      ["Needs action", B.rows.filter(needsAction).length, "warn"],
      ["Arriving in 7 days", arriving, ""],
      [`Paid in ${S.MONTHS[Number(month.slice(5)) - 1]}`, S.inr(paidMonth), "ok"],
      ["Bookings loaded", B.rows.length, ""],
    ].map(([l, v, c]) => `<div class="stat ${c}"><div class="stat-label">${S.esc(l)}</div><div class="stat-value">${S.esc(v)}</div></div>`).join("");

    // Location filter appears once bookings span more than one location
    const locs = [...new Map(B.rows.filter((r) => r.location_id).map((r) => [r.location_id, r.location_name || r.location_id])).entries()];
    const lf = $("#loc-filter");
    lf.hidden = locs.length < 2;
    if (locs.length >= 2) {
      if (B.loc !== "all" && !locs.some(([id]) => id === B.loc)) B.loc = "all";
      lf.innerHTML = `<option value="all">All locations</option>` + locs.map(([id, n]) => `<option value="${S.esc(id)}"${B.loc === id ? " selected" : ""}>${S.esc(n)}</option>`).join("");
    } else B.loc = "all";
    const showLoc = locs.length >= 2;

    $("#status-chips").innerHTML = CHIPS.map(([k, label, fn]) =>
      `<button type="button" class="chip${B.filter === k ? " active" : ""}" data-action="chip" data-chip="${k}">${label} <span>${B.rows.filter(fn).length}</span></button>`).join("");

    const list = filtered();
    $("#bk-empty").hidden = list.length > 0;
    $("#bk-empty").textContent = B.rows.length ? "Nothing here. Try another filter." : "No bookings yet.";
    $("#bk-table").hidden = !list.length;
    $("#bk-rows").innerHTML = list.map((r) => `
      <tr data-action="open" data-id="${S.esc(r.id)}" tabindex="0" class="${needsAction(r) ? "row-action" : ""}">
        <td><div class="strong">${S.esc(r.guest_name)}</div><div class="sub">${S.esc(r.guest_email || r.guest_phone || "")}</div></td>
        <td>${S.esc(r.room_name)}${r.num_units > 1 ? ` <span class="muted">× ${S.esc(r.num_units)}</span>` : ""}${showLoc && r.location_name ? `<div class="sub">${S.esc(r.location_name)}</div>` : ""}</td>
        <td><div>${S.esc(S.fmtDate(r.check_in))} → ${S.esc(S.fmtDate(r.check_out))}</div><div class="sub">${S.plural(S.nightsBetween(r.check_in, r.check_out), "night")}</div></td>
        <td class="num">${S.esc(r.num_guests)}</td>
        <td>${statusBadge(r)}</td>
        <td>${payBadge(r)}</td>
        <td class="num">${r.total_paise ? S.inr(r.total_paise) : "—"}</td>
        <td class="sub mono">${S.esc(r.ref)}</td>
      </tr>`).join("");
    $("#bk-count").textContent = `Showing ${list.length} of ${B.rows.length}`;
    $("#load-more").hidden = !B.more;
  }

  function replaceRow(b) {
    const i = B.rows.findIndex((r) => r.id === b.id);
    if (i >= 0) B.rows[i] = { ...B.rows[i], ...b }; else B.rows.unshift(b);
    renderBookings();
    return B.rows.find((r) => r.id === b.id);
  }

  // ---------- dialog ----------
  function openDialog(title, sub, html) {
    $("#dlg-title").textContent = title;
    $("#dlg-sub").textContent = sub || "";
    $("#dlg-body").innerHTML = html;
    $("#dlg").hidden = false;
    document.body.classList.add("modal-open");
    setTimeout(() => { const f = $("#dlg-body input, #dlg-body select, #dlg-body button"); if (f) f.focus(); }, 20);
  }
  function closeDialog() {
    $("#dlg").hidden = true;
    document.body.classList.remove("modal-open");
    B.current = null;
  }

  function priceRows(r) {
    const q = r.quote || {};
    if (!q.priced) return `<p class="muted">Price on request — no price was set for this room.</p>`;
    const rows = S.groupNights(q).map((g) => `<div class="kv"><span>${S.plural(g.count, "night")}${r.num_units > 1 ? ` × ${r.num_units}` : ""} @ ${S.inrRupees(g.tariff)}${g.gst_rate ? ` (GST ${g.gst_rate}%)` : ""}</span><b>${S.inr(g.count * g.tariff * r.num_units * 100)}</b></div>`).join("");
    return `${rows}${r.gst_paise ? `<div class="kv"><span>GST</span><b>${S.inr(r.gst_paise)}</b></div>` : ""}<div class="kv kv-total"><span>Total</span><b>${S.inr(r.total_paise)}</b></div>`;
  }

  function openBooking(id) {
    const r = B.rows.find((x) => x.id === id);
    if (!r) return;
    B.current = r;
    const st = effectiveStatus(r);
    const tel = String(r.guest_phone || "").replace(/[^\d+]/g, "");
    const wa = tel.replace(/^\+/, "");
    const unpaid = r.payment_status === "unpaid" && r.total_paise > 0;
    const actions = [];
    if (st === "hold") actions.push(["confirmed", "Confirm booking", "btn-ok"], ["cancelled", "Cancel", "btn-bad"]);
    if (st === "confirmed") actions.push(["completed", "Mark stay completed", ""], ["cancelled", "Cancel booking", "btn-bad"]);
    if (st === "inquiry") actions.push(["completed", "Mark handled", ""], ["cancelled", "Close inquiry", "btn-bad"]);
    if (st === "expired" || st === "cancelled") actions.push(["confirmed", "Re-confirm (if dates still free)", ""]);
    const canPay = unpaid && ["confirmed", "completed"].includes(st);
    const canRefund = r.payment_status === "paid" && (["cancelled", "expired"].includes(st) || r.needs_attention);
    const canDelete = r.payment_status === "unpaid" && !r.invoice_no;
    const doc = r.payment_status === "paid" && r.invoice_no ? "Download invoice" : r.source !== "inquiry" ? "Download booking summary" : "";

    openDialog(r.guest_name, `${r.ref} · booked ${S.fmtDateTime(r.created_at)}`, `
      ${r.needs_attention ? `<div class="alert">⚠️ Needs attention. ${S.esc(r.admin_notes || "")}</div>` : ""}
      <div class="badges">${statusBadge(r)} ${payBadge(r)}</div>
      <section class="box"><h3>Guest</h3>
        <div class="kv"><span>Name</span><b>${S.esc(r.guest_name)}</b></div>
        <div class="kv"><span>Email</span><b>${r.guest_email ? `<a href="mailto:${S.esc(r.guest_email)}">${S.esc(r.guest_email)}</a>` : "—"}</b></div>
        <div class="kv"><span>Phone</span><b>${tel ? `<a href="tel:${S.esc(tel)}">${S.esc(r.guest_phone)}</a> · <a href="https://wa.me/${S.esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : "—"}</b></div>
      </section>
      <section class="box"><h3>Stay</h3>
        <div class="kv"><span>Room</span><b>${S.esc(r.room_name)}${r.num_units > 1 ? ` × ${S.esc(r.num_units)}` : ""}</b></div>
        ${r.location_name ? `<div class="kv"><span>Location</span><b>${S.esc(r.location_name)}</b></div>` : ""}
        <div class="kv"><span>Dates</span><b>${S.esc(S.fmtDate(r.check_in, true))} → ${S.esc(S.fmtDate(r.check_out, true))} (${S.plural(S.nightsBetween(r.check_in, r.check_out), "night")})</b></div>
        <div class="kv"><span>Guests</span><b>${S.esc(r.num_guests)}</b></div>
        <div class="kv"><span>Booked via</span><b>${S.esc({ online: "Website · pay online", arrival: "Website · pay on arrival", inquiry: "Website · inquiry", manual: "Added by admin" }[r.source] || r.source)}</b></div>
        ${st === "hold" ? `<div class="kv"><span>Hold expires</span><b>${S.esc(S.fmtDateTime(r.hold_expires_at))} (${S.esc(S.timeLeft(r.hold_expires_at))})</b></div>` : ""}
        ${r.special_requests ? `<div class="requests"><span>Special requests</span><p>${S.esc(r.special_requests)}</p></div>` : ""}
      </section>
      <section class="box"><h3>Price &amp; payment</h3>${priceRows(r)}
        ${r.invoice_no ? `<div class="kv"><span>Invoice</span><b>${S.esc(r.invoice_no)} · ${S.esc(S.fmtDate(r.invoice_date))}</b></div>` : ""}
        ${r.razorpay_payment_id ? `<div class="kv"><span>Razorpay payment</span><b class="mono">${S.esc(r.razorpay_payment_id)}</b></div>` : ""}
        ${r.razorpay_order_id ? `<div class="kv"><span>Razorpay order</span><b class="mono">${S.esc(r.razorpay_order_id)}</b></div>` : ""}
        ${r.paid_at ? `<div class="kv"><span>Paid</span><b>${S.esc(S.fmtDateTime(r.paid_at))} · ${S.esc(r.payment_method || "")}</b></div>` : ""}
        ${canPay ? `<div class="pay-row"><select id="pay-method" aria-label="Payment method"><option value="upi">UPI</option><option value="cash">Cash</option><option value="card">Card</option><option value="bank">Bank transfer</option><option value="other">Other</option></select>
          <button class="btn btn-sm btn-ok" type="button" data-action="record-pay">Record ${S.inr(r.total_paise)} received</button></div>` : ""}
      </section>
      <label class="field"><span>Private notes (guests never see these)</span><textarea id="notes" rows="3" maxlength="4000">${S.esc(r.admin_notes || "")}</textarea></label>
      <button class="btn btn-quiet btn-sm" type="button" data-action="save-notes">Save notes</button>
      <div class="actions">${actions.map(([s, label, cls]) => `<button class="btn ${cls}" type="button" data-action="set-status" data-status="${s}">${label}</button>`).join("")}
        ${canRefund ? `<button class="btn btn-quiet" type="button" data-action="refunded">Mark refunded</button>` : ""}
        ${doc ? `<button class="btn btn-quiet" type="button" data-action="doc">${doc}</button>` : ""}</div>
      ${canDelete ? `<div class="danger"><button class="link link-bad" type="button" data-action="delete">Delete this booking permanently</button></div>` : ""}`);
  }

  async function act(btn, fn, okText) {
    busy(btn, true);
    try {
      const b = await fn();
      if (b && b.id) { const row = replaceRow(b); if (okText) toast(okText); openBooking(row.id); }
      return true;
    } catch (e) {
      toast(S.friendly(e), true);
      busy(btn, false);
      return false;
    }
  }

  function setStatus(btn, status) {
    const r = B.current;
    if (status === "cancelled" && !confirm(`Cancel ${r.guest_name}'s booking? The dates become available again.${r.payment_status === "paid" ? "\n\nThis booking is PAID — refund it in Razorpay (or by hand) and then click “Mark refunded”." : ""}`)) return;
    act(btn, () => aRpc("admin_set_status", { p_id: r.id, p_status: status }), { confirmed: "Booking confirmed.", completed: "Marked completed.", cancelled: "Booking cancelled." }[status]);
  }
  function recordPayment(btn) {
    const r = B.current, m = $("#pay-method").value;
    if (!confirm(`Record ${S.inr(r.total_paise)} received by ${m.toUpperCase()}? This issues invoice number for ${r.guest_name}.`)) return;
    act(btn, () => aRpc("admin_record_payment", { p_id: r.id, p_method: m }), "Payment recorded — invoice issued.");
  }
  function markRefunded(btn) {
    if (!confirm("Mark this payment as refunded? Do this only after the money has actually been returned.")) return;
    act(btn, () => aRpc("admin_mark_refunded", { p_id: B.current.id }), "Marked refunded.");
  }
  async function saveNotes(btn) {
    const r = B.current, notes = $("#notes").value.trim();
    busy(btn, true, "Saving…");
    try {
      const rows = await aRest(`bookings?id=eq.${encodeURIComponent(r.id)}`, { method: "PATCH", body: { admin_notes: notes || null }, prefer: "return=representation" });
      if (!rows.length) throw new S.ApiError("not_authorised", 403);
      replaceRow(rows[0]);
      toast("Notes saved.");
    } catch (e) { toast(S.friendly(e), true); }
    busy(btn, false);
  }
  async function deleteBooking(btn) {
    const r = B.current;
    if (!confirm(`Permanently delete ${r.guest_name}'s ${r.status} booking (${r.ref})?\n\nUse this only for spam or test bookings.`)) return;
    busy(btn, true, "Deleting…");
    try {
      await aRpc("admin_delete_booking", { p_id: r.id });
      B.rows = B.rows.filter((x) => x.id !== r.id);
      closeDialog(); renderBookings(); toast("Booking deleted.");
    } catch (e) { toast(S.friendly(e), true); busy(btn, false); }
  }
  async function downloadDoc(btn) {
    busy(btn, true, "Preparing PDF…");
    try { await S.downloadInvoice(B.current); } catch (e) { console.error(e); toast("Couldn't create the PDF.", true); }
    busy(btn, false);
  }

  // ---------- manual booking ----------
  async function newBookingDialog() {
    if (!R.rows.length) await Promise.all([fetchRooms(), fetchLocations()]).catch(() => {});
    if (!R.rows.length) { toast("Add a room first (Rooms tab).", true); return; }
    const t = today();
    openDialog("Add a booking", "Phone, walk-in or owner block — confirmed immediately and blocks the dates", `
      <form id="f-manual" class="stack" novalidate>
        <label class="field"><span>Room</span><select name="room">${R.rows.map((r) => `<option value="${S.esc(r.id)}">${S.esc(r.name)}${r.location_id && locName(r.location_id) ? ` · ${S.esc(locName(r.location_id))}` : ""}${r.is_active ? "" : " (hidden)"} — ${r.max_units} unit${r.max_units > 1 ? "s" : ""}</option>`).join("")}</select></label>
        <div class="grid2">
          <label class="field"><span>Check-in</span><input name="ci" type="date" value="${t}" required /></label>
          <label class="field"><span>Check-out</span><input name="co" type="date" value="${S.addDays(t, 1)}" required /></label>
          <label class="field"><span>Rooms</span><input name="units" type="number" min="1" max="99" value="1" required /></label>
          <label class="field"><span>Guests</span><input name="guests" type="number" min="1" max="500" value="2" required /></label>
        </div>
        <label class="field"><span>Guest name (or e.g. “Owner block — maintenance”)</span><input name="name" maxlength="100" required /></label>
        <div class="grid2">
          <label class="field"><span>Phone <em>(optional)</em></span><input name="phone" type="tel" maxlength="20" /></label>
          <label class="field"><span>Email <em>(optional)</em></span><input name="email" type="email" maxlength="254" /></label>
        </div>
        <label class="field"><span>Requests / notes <em>(optional)</em></span><textarea name="req" rows="2" maxlength="1000"></textarea></label>
        <p class="msg msg-bad" id="manual-err" hidden></p>
        <button class="btn" type="submit">Add booking</button>
      </form>`);
  }
  async function saveManual(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const v = Object.fromEntries(f.entries());
    const err = !v.name.trim() ? "Enter a name." : !(v.co > v.ci) ? "Check-out must be after check-in."
      : v.email && !EMAIL_RE.test(v.email) ? "That email doesn't look right." : v.phone && !PHONE_RE.test(v.phone) ? "That phone number doesn't look right." : "";
    if (err) { showMsg("#manual-err", err, "bad"); return; }
    const btn = e.target.querySelector("button[type=submit]");
    busy(btn, true, "Adding…");
    try {
      const b = await aRpc("admin_create_booking", {
        p_room_id: v.room, p_check_in: v.ci, p_check_out: v.co, p_units: Number(v.units), p_guests: Number(v.guests),
        p_name: v.name.trim(), p_email: v.email.trim() || null, p_phone: v.phone.trim() || null, p_requests: v.req.trim() || null,
      });
      B.filter = "upcoming";
      replaceRow(b);
      toast("Booking added.");
      openBooking(b.id);
    } catch (ex) {
      showMsg("#manual-err", S.friendly(ex), "bad");
      busy(btn, false);
    }
  }

  // ---------- CSV ----------
  function exportCsv() {
    const list = filtered();
    if (!list.length) { toast("Nothing to export with this filter.", true); return; }
    // Prefix cells that spreadsheet apps would run as formulas (CSV injection).
    const cell = (v) => {
      let s = v == null ? "" : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const money = (p) => (p ? (Number(p) / 100).toFixed(2) : "");
    const head = ["Ref", "Booked at", "Guest", "Email", "Phone", "Location", "Room", "Rooms", "Check-in", "Check-out", "Nights", "Guests", "Source", "Status", "Payment", "Method",
      "Subtotal", "GST", "Total", "Invoice no", "Invoice date", "Razorpay payment", "Razorpay order", "Requests", "Notes"];
    const rows = list.map((r) => [r.ref, r.created_at, r.guest_name, r.guest_email, r.guest_phone, r.location_name, r.room_name, r.num_units, r.check_in, r.check_out,
      S.nightsBetween(r.check_in, r.check_out), r.num_guests, r.source, effectiveStatus(r), r.payment_status, r.payment_method,
      money(r.subtotal_paise), money(r.gst_paise), money(r.total_paise), r.invoice_no, r.invoice_date, r.razorpay_payment_id, r.razorpay_order_id,
      r.special_requests, r.admin_notes].map(cell).join(","));
    const blob = new Blob(["﻿" + head.join(",") + "\r\n" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${String(CFG.brand?.fileSlug || "Stay").replace(/[^A-Za-z0-9]/g, "")}-bookings-${today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ==================================================================
  //  Rooms
  // ==================================================================
  const R = { rows: [], newCount: 0 };
  async function fetchRooms() {
    R.rows = await aRest("rooms?select=*&order=sort_order.asc,name.asc");
    return R.rows;
  }
  async function loadRooms() {
    $("#rooms-list").innerHTML = `<p class="empty">Loading…</p>`;
    try { await Promise.all([fetchRooms(), fetchLocations()]); renderRooms(); } catch (e) { $("#rooms-list").innerHTML = `<p class="empty">${S.esc(S.friendly(e))}</p>`; }
  }
  const locName = (id) => (Lc.rows.find((l) => l.id === id) || {}).name || "";
  function locationSelect(current) {
    const opts = Lc.rows.map((l) => `<option value="${S.esc(l.id)}"${l.id === current ? " selected" : ""}>${S.esc(l.name)}${l.is_active ? "" : " (hidden)"}</option>`).join("");
    return `<select name="location_id">${!current ? `<option value="" selected>— Choose a location —</option>` : ""}${opts}</select>`;
  }
  const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "room";

  function roomForm(r, isNew) {
    const key = isNew ? `new-${++R.newCount}` : r.id;
    const img = S.safeUrl(r.image_url, "images/placeholder-room.svg");
    return `<form class="card room-edit" data-room="${S.esc(key)}" data-new="${isNew ? 1 : 0}" novalidate>
      <div class="room-edit-head">
        <img src="${S.esc(img)}" alt="" class="thumb" />
        <div class="grow"><h3>${S.esc(r.name || "New room")}</h3><p class="sub">${isNew ? "Not saved yet" : `ID: ${S.esc(r.id)}${r.location_id ? ` · 📍 ${S.esc(locName(r.location_id))}` : ""} · ${r.is_active ? "shown on website" : "hidden"}`}</p></div>
        <span class="room-price-tag">${r.price_per_night ? S.inrRupees(r.price_per_night) + "/night" : "Price on request"}</span>
      </div>
      <label class="check"><input type="checkbox" name="is_active" ${r.is_active !== false ? "checked" : ""} /> Show on website and accept bookings</label>
      <div class="grid2">
        <label class="field"><span>Room name</span><input name="name" maxlength="80" value="${S.esc(r.name || "")}" required /></label>
        <label class="field"><span>Location</span>${locationSelect(r.location_id)}</label>
        <label class="field"><span>Capacity shown to guests</span><input name="capacity_label" maxlength="80" value="${S.esc(r.capacity_label || "")}" placeholder="2 Adults + 1 Child" /></label>
        <label class="field"><span>Max guests per room</span><input name="max_guests" type="number" min="1" max="50" value="${S.esc(r.max_guests || 2)}" required /></label>
        <label class="field"><span>How many of this room you have</span><input name="max_units" type="number" min="1" max="99" value="${S.esc(r.max_units || 1)}" required /></label>
        <label class="field"><span>Price per night (₹) — empty = price on request</span><input name="price_per_night" type="number" min="1" step="1" value="${S.esc(r.price_per_night || "")}" /></label>
        <label class="field"><span>Weekend price (₹) <em>(optional)</em></span><input name="weekend_price" type="number" min="1" step="1" value="${S.esc(r.weekend_price || "")}" /></label>
      </div>
      <label class="field"><span>Description</span><textarea name="description" rows="2" maxlength="2000">${S.esc(r.description || "")}</textarea></label>
      <label class="field"><span>Features — one per line</span><textarea name="features" rows="4">${S.esc((r.features || []).join("\n"))}</textarea></label>
      <div class="grid2">
        <label class="field"><span>Photo (JPEG/PNG/WebP, max 5 MB)</span><input name="photo" type="file" accept="image/jpeg,image/png,image/webp" /></label>
        <label class="field"><span>Display order</span><input name="sort_order" type="number" value="${S.esc(r.sort_order ?? 0)}" /></label>
      </div>
      <p class="msg" data-msg hidden></p>
      <div class="row">
        <button class="btn" type="submit">${isNew ? "Create room" : "Save changes"}</button>
        ${isNew ? `<button class="btn btn-quiet" type="button" data-action="discard-room">Discard</button>` : `<button class="link link-bad" type="button" data-action="delete-room">Delete room</button>`}
      </div>
    </form>`;
  }
  function renderRooms() {
    $("#rooms-list").innerHTML = R.rows.length ? R.rows.map((r) => roomForm(r, false)).join("") : `<p class="empty">No rooms yet — click “+ Add room”.</p>`;
  }
  function addRoom() {
    const list = $("#rooms-list");
    if (!R.rows.length) list.innerHTML = "";
    list.insertAdjacentHTML("afterbegin", roomForm({ is_active: true, max_guests: 2, max_units: 1, sort_order: R.rows.length + 1, location_id: (Lc.rows[0] || {}).id }, true));
    list.firstElementChild.querySelector("input[name=name]").focus();
  }

  async function uploadPhoto(roomId, file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new S.ApiError("bad_image", 400);
    if (file.size > 5 * 1024 * 1024) throw new S.ApiError("too_big", 400);
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type];
    const path = `${roomId}-${Date.now()}.${ext}`;
    await authed((t) => S.request(`${SB.url}/storage/v1/object/room-images/${path}`, {
      method: "POST", token: t, raw: true, body: file, headers: { "Content-Type": file.type, "cache-control": "max-age=31536000", "x-upsert": "false" },
    }));
    return `${SB.url}/storage/v1/object/public/room-images/${path}`;
  }

  async function saveRoom(e) {
    e.preventDefault();
    const form = e.target, isNew = form.dataset.new === "1";
    const msg = form.querySelector("[data-msg]");
    const f = new FormData(form);
    const num = (k) => (f.get(k) === "" ? null : Number(f.get(k)));
    const payload = {
      name: String(f.get("name")).trim(), capacity_label: String(f.get("capacity_label")).trim() || null,
      location_id: String(f.get("location_id") || "") || null,
      max_guests: num("max_guests"), max_units: num("max_units"), price_per_night: num("price_per_night"), weekend_price: num("weekend_price"),
      description: String(f.get("description")).trim() || null,
      features: String(f.get("features")).split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 30),
      sort_order: num("sort_order") || 0, is_active: f.get("is_active") === "on",
    };
    const bad = !payload.name ? "Enter a room name."
      : !payload.location_id && Lc.rows.length ? "Choose which location this room is in."
      : !(payload.max_guests >= 1) ? "Max guests must be at least 1." : !(payload.max_units >= 1) ? "Number of rooms must be at least 1."
      : payload.price_per_night !== null && !(Number.isInteger(payload.price_per_night) && payload.price_per_night >= 1) ? "Price must be a whole number of rupees."
      : payload.weekend_price !== null && !(Number.isInteger(payload.weekend_price) && payload.weekend_price >= 1) ? "Weekend price must be a whole number of rupees."
      : payload.weekend_price && !payload.price_per_night ? "Set a weekday price before a weekend price." : "";
    if (bad) { msg.textContent = bad; msg.className = "msg msg-bad"; msg.hidden = false; return; }

    const btn = form.querySelector("button[type=submit]");
    busy(btn, true, "Saving…");
    msg.hidden = true;
    try {
      let id = form.dataset.room;
      if (isNew) {
        id = slug(payload.name);
        let n = 2;
        while (R.rows.some((r) => r.id === id)) id = `${slug(payload.name).slice(0, 36)}-${n++}`;
      }
      const file = f.get("photo");
      if (file && file.size) { btn.textContent = "Uploading photo…"; payload.image_url = await uploadPhoto(id, file); }
      const rows = isNew
        ? await aRest("rooms", { method: "POST", body: { id, ...payload }, prefer: "return=representation" })
        : await aRest(`rooms?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: payload, prefer: "return=representation" });
      if (!rows.length) throw new S.ApiError("not_authorised", 403);
      await fetchRooms();
      renderRooms();
      toast(isNew ? "Room created — it's live on the website." : "Saved — changes are live.");
    } catch (ex) {
      msg.textContent = ex.code === "bad_image" ? "Use a JPEG, PNG or WebP image." : ex.code === "too_big" ? "That photo is over 5 MB — please resize it." : S.friendly(ex);
      msg.className = "msg msg-bad"; msg.hidden = false;
      busy(btn, false);
    }
  }
  async function deleteRoom(form) {
    const id = form.dataset.room;
    if (!confirm("Delete this room? (Rooms that have bookings can't be deleted — hide them instead.)")) return;
    try {
      const rows = await aRest(`rooms?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", prefer: "return=representation" });
      if (!rows.length) throw new S.ApiError("not_authorised", 403);
      await fetchRooms(); renderRooms(); toast("Room deleted.");
    } catch (e) { toast(S.friendly(e), true); }
  }

  // ==================================================================
  //  Locations
  // ==================================================================
  const Lc = { rows: [], newCount: 0, gst: null };
  async function fetchLocations() {
    Lc.rows = await aRest("locations?select=*&order=sort_order.asc,name.asc");
    return Lc.rows;
  }
  async function loadLocations() {
    $("#locations-list").innerHTML = `<p class="empty">Loading…</p>`;
    try {
      const [, , settings] = await Promise.all([fetchLocations(), fetchRooms(), aRest("settings?select=gst_enabled,gstin")]);
      Lc.gst = settings[0] || null;
      renderLocations();
    } catch (e) { $("#locations-list").innerHTML = `<p class="empty">${S.esc(S.friendly(e))}</p>`; }
  }
  function gstWarning(l) {
    const g = Lc.gst;
    if (!g || !g.gst_enabled || l.gstin || !l.state) return "";
    const code = stateCode(l.state);
    return code && g.gstin && g.gstin.slice(0, 2) !== code
      ? `GST is on and your main GSTIN is for state code ${g.gstin.slice(0, 2)}, but ${l.state} is ${code}. Add ${l.state}'s GSTIN below before taking bookings here.` : "";
  }
  function locationForm(l, isNew) {
    const key = isNew ? `new-${++Lc.newCount}` : l.id;
    const rooms = R.rows.filter((r) => r.location_id === l.id).length;
    const st = l.state || "Tamil Nadu";
    const opts = (STATES.some(([n]) => n === st) ? "" : `<option selected>${S.esc(st)}</option>`)
      + STATES.map(([n, c]) => `<option value="${S.esc(n)}"${n === st ? " selected" : ""}>${S.esc(n)} (${c})</option>`).join("");
    const warn = isNew ? "" : gstWarning(l);
    return `<form class="card loc-edit" data-loc="${S.esc(key)}" data-new="${isNew ? 1 : 0}" novalidate>
      <div class="room-edit-head">
        <div class="grow"><h3>📍 ${S.esc(l.name || "New location")}</h3>
          <p class="sub">${isNew ? "Not saved yet" : `ID: ${S.esc(l.id)} · ${S.plural(rooms, "room")} · ${l.is_active ? "shown on website" : "hidden"}`}</p></div>
      </div>
      ${warn ? `<p class="msg msg-bad">${S.esc(warn)}</p>` : ""}
      <label class="check"><input type="checkbox" name="is_active" ${l.is_active !== false ? "checked" : ""} /> Show on website (hiding a location also hides its rooms)</label>
      <div class="grid2">
        <label class="field"><span>Name</span><input name="name" maxlength="80" value="${S.esc(l.name || "")}" placeholder="Auroville" required /></label>
        <label class="field"><span>Short line under the name <em>(optional)</em></span><input name="area_label" maxlength="80" value="${S.esc(l.area_label || "")}" placeholder="Near Pondicherry" /></label>
        <label class="field"><span>Town / city</span><input name="city" maxlength="80" value="${S.esc(l.city || "")}" /></label>
        <label class="field"><span>State (decides GST place of supply)</span><select name="state">${opts}</select></label>
        <label class="field"><span>PIN code <em>(optional)</em></span><input name="postal_code" inputmode="numeric" maxlength="6" value="${S.esc(l.postal_code || "")}" /></label>
        <label class="field"><span>Google Maps link <em>(optional)</em></span><input name="map_url" type="url" maxlength="500" value="${S.esc(l.map_url || "")}" placeholder="https://maps.app.goo.gl/…" /></label>
        <label class="field"><span>Latitude <em>(optional)</em></span><input name="latitude" inputmode="decimal" value="${S.esc(l.latitude ?? "")}" placeholder="12.0060" /></label>
        <label class="field"><span>Longitude <em>(optional)</em></span><input name="longitude" inputmode="decimal" value="${S.esc(l.longitude ?? "")}" placeholder="79.8106" /></label>
        <label class="field"><span>GSTIN for this state <em>(only if different from Settings)</em></span><input name="gstin" maxlength="15" value="${S.esc(l.gstin || "")}" autocapitalize="characters" /></label>
        <label class="field"><span>Display order</span><input name="sort_order" type="number" value="${S.esc(l.sort_order ?? 0)}" /></label>
      </div>
      <label class="field"><span>Address — one line per row</span><textarea name="address_lines" rows="2">${S.esc((l.address_lines || []).join("\n"))}</textarea></label>
      <label class="field"><span>Short description for guests <em>(optional)</em></span><textarea name="description" rows="2" maxlength="1000">${S.esc(l.description || "")}</textarea></label>
      <p class="msg" data-msg hidden></p>
      <div class="row">
        <button class="btn" type="submit">${isNew ? "Create location" : "Save changes"}</button>
        ${isNew ? `<button class="btn btn-quiet" type="button" data-action="discard-location">Discard</button>` : `<button class="link link-bad" type="button" data-action="delete-location">Delete location</button>`}
      </div>
    </form>`;
  }
  function renderLocations() {
    $("#locations-list").innerHTML = Lc.rows.length ? Lc.rows.map((l) => locationForm(l, false)).join("") : `<p class="empty">No locations yet — click “+ Add location”.</p>`;
  }
  function addLocation() {
    const list = $("#locations-list");
    if (!Lc.rows.length) list.innerHTML = "";
    list.insertAdjacentHTML("afterbegin", locationForm({ is_active: true, sort_order: Lc.rows.length + 1 }, true));
    list.firstElementChild.querySelector("input[name=name]").focus();
  }
  async function saveLocation(e) {
    e.preventDefault();
    const form = e.target, isNew = form.dataset.new === "1", msg = form.querySelector("[data-msg]");
    const f = new FormData(form);
    const txt = (k) => String(f.get(k) || "").trim();
    const num = (k) => (txt(k) === "" ? null : Number(txt(k)));
    const payload = {
      name: txt("name"), area_label: txt("area_label") || null, city: txt("city") || null, state: txt("state"),
      postal_code: txt("postal_code") || null, map_url: txt("map_url") || null, latitude: num("latitude"), longitude: num("longitude"),
      gstin: txt("gstin").toUpperCase() || null, sort_order: num("sort_order") || 0, is_active: f.get("is_active") === "on",
      address_lines: lines(f.get("address_lines")).slice(0, 6), description: txt("description") || null,
    };
    const code = stateCode(payload.state);
    const bad = !payload.name ? "Enter a name for this location." : !payload.state ? "Choose the state."
      : payload.postal_code && !/^[0-9]{6}$/.test(payload.postal_code) ? "PIN code should be 6 digits."
      : payload.map_url && !/^https:\/\/\S+$/.test(payload.map_url) ? "The map link must start with https://"
      : payload.latitude !== null && !(Math.abs(payload.latitude) <= 90) ? "Latitude must be a number between -90 and 90."
      : payload.longitude !== null && !(Math.abs(payload.longitude) <= 180) ? "Longitude must be a number between -180 and 180."
      : payload.gstin && !GSTIN_RE.test(payload.gstin) ? "That GSTIN doesn't look right (15 characters, e.g. 33ABCDE1234F1Z5)."
      : payload.gstin && code && payload.gstin.slice(0, 2) !== code ? `A GSTIN for ${payload.state} must start with ${code}.`
      : payload.address_lines.some((l) => l.length > 120) ? "Keep each address line under 120 characters." : "";
    if (bad) { msg.textContent = bad; msg.className = "msg msg-bad"; msg.hidden = false; return; }
    const btn = form.querySelector("button[type=submit]");
    busy(btn, true, "Saving…");
    msg.hidden = true;
    try {
      let id = form.dataset.loc;
      if (isNew) { id = slug(payload.name); let n = 2; while (Lc.rows.some((l) => l.id === id)) id = `${slug(payload.name).slice(0, 36)}-${n++}`; }
      const rows = isNew
        ? await aRest("locations", { method: "POST", body: { id, ...payload }, prefer: "return=representation" })
        : await aRest(`locations?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: payload, prefer: "return=representation" });
      if (!rows.length) throw new S.ApiError("not_authorised", 403);
      await fetchLocations();
      renderLocations();
      toast(isNew ? "Location created — now add rooms to it in the Rooms tab." : "Saved — changes are live.");
    } catch (ex) {
      msg.textContent = S.friendly(ex); msg.className = "msg msg-bad"; msg.hidden = false;
      busy(btn, false);
    }
  }
  async function deleteLocation(form) {
    const id = form.dataset.loc;
    if (R.rows.some((r) => r.location_id === id)) { toast("This location still has rooms — move or delete them first (Rooms tab), or untick “Show on website” to hide it.", true); return; }
    if (!confirm("Delete this location?")) return;
    try {
      const rows = await aRest(`locations?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", prefer: "return=representation" });
      if (!rows.length) throw new S.ApiError("not_authorised", 403);
      await fetchLocations(); renderLocations(); toast("Location deleted.");
    } catch (e) {
      toast(e.detail && e.detail.code === "23503" ? "This location still has rooms — move them first." : S.friendly(e), true);
    }
  }

  // ==================================================================
  //  Settings
  // ==================================================================
  async function loadSettings() {
    const form = $("#f-settings");
    try {
      const [s] = await aRest("settings?select=*");
      for (const el of form.elements) {
        if (!el.name || !(el.name in s)) continue;
        if (el.type === "checkbox") el.checked = !!s[el.name];
        else el.value = Array.isArray(s[el.name]) ? s[el.name].join("\n") : s[el.name] ?? "";
      }
      $("#weekend-days").innerHTML = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) =>
        `<label class="check day-check"><input type="checkbox" value="${i}" ${s.weekend_nights.includes(i) ? "checked" : ""} /> ${d}</label>`).join("");
    } catch (e) { showMsg("#settings-msg", S.friendly(e), "bad"); }
  }
  async function saveSettings(e) {
    e.preventDefault();
    const form = e.target, f = new FormData(form);
    const body = {
      business_legal_name: String(f.get("business_legal_name")).trim(),
      gst_enabled: f.get("gst_enabled") === "on",
      gstin: String(f.get("gstin")).trim().toUpperCase() || null,
      invoice_prefix: String(f.get("invoice_prefix")).trim().toUpperCase(),
      allow_pay_on_arrival: f.get("allow_pay_on_arrival") === "on",
      arrival_hold_hours: Number(f.get("arrival_hold_hours")), online_hold_minutes: Number(f.get("online_hold_minutes")),
      max_nights: Number(f.get("max_nights")), booking_window_days: Number(f.get("booking_window_days")),
      timezone: String(f.get("timezone")).trim(),
      weekend_nights: $$("#weekend-days input:checked").map((i) => Number(i.value)),
      contact_phones: lines(f.get("contact_phones")), contact_emails: lines(f.get("contact_emails")).map((x) => x.toLowerCase()),
      contact_address: lines(f.get("contact_address")), contact_whatsapp: String(f.get("contact_whatsapp") || "").trim() || null,
      contact_map_url: String(f.get("contact_map_url") || "").trim() || null, contact_hours: String(f.get("contact_hours") || "").trim() || null,
    };
    const badPhone = body.contact_phones.find((p) => !PHONE_RE.test(p));
    const badEmail = body.contact_emails.find((m) => !EMAIL_RE.test(m));
    const bad = !body.contact_phones.length && !body.contact_emails.length ? "Add at least one phone number or email so guests can reach you."
      : badPhone ? `“${badPhone}” isn't a valid phone number (digits, spaces, + and brackets only).`
      : badEmail ? `“${badEmail}” isn't a valid email address.`
      : body.contact_phones.length > 5 || body.contact_emails.length > 5 ? "Up to 5 phone numbers and 5 emails."
      : body.contact_whatsapp && !PHONE_RE.test(body.contact_whatsapp) ? "The WhatsApp number doesn't look right."
      : body.contact_address.length > 6 || body.contact_address.some((l) => l.length > 120) ? "Keep the address to 6 lines of up to 120 characters."
      : body.contact_map_url && !/^https:\/\/\S+$/.test(body.contact_map_url) ? "The map link must start with https://"
      : !body.business_legal_name ? "Enter your legal business name."
      : body.gst_enabled && !body.gstin ? "Enter your GSTIN, or switch GST off."
      : body.gstin && !GSTIN_RE.test(body.gstin) ? "That GSTIN doesn't look right (15 characters, e.g. 33ABCDE1234F1Z5)."
      : !/^[A-Z0-9]{1,5}$/.test(body.invoice_prefix) ? "Invoice prefix: 1–5 capital letters or numbers." : "";
    if (bad) { showMsg("#settings-msg", bad, "bad"); return; }
    if (body.timezone !== TZ) { if (!confirm(`The time zone differs from config.js (“${TZ}”). Update config.js to match, or dates may look off. Save anyway?`)) return; }
    const btn = $("#settings-btn");
    busy(btn, true, "Saving…");
    try {
      const rows = await aRest("settings?id=eq.true", { method: "PATCH", body, prefer: "return=representation" });
      if (!rows.length) throw new S.ApiError("not_authorised", 403);
      let note = "";
      if (body.gst_enabled) {   // locations in another state need their own GSTIN
        const locs = await fetchLocations().catch(() => []);
        const off = locs.filter((l) => l.is_active && !l.gstin && stateCode(l.state) && stateCode(l.state) !== body.gstin.slice(0, 2));
        if (off.length) note = ` Heads-up: ${off.map((l) => `${l.name} (${l.state})`).join(", ")} ${off.length > 1 ? "are" : "is"} in a different state from this GSTIN — add that state's GSTIN in the Locations tab.`;
      }
      showMsg("#settings-msg", "Saved — contact details and settings are live on the website." + note, note ? "bad" : "ok");
    } catch (ex) { showMsg("#settings-msg", S.friendly(ex), "bad"); }
    busy(btn, false);
  }

  // ==================================================================
  //  Change password (signed in)
  // ==================================================================
  function changePasswordDialog() {
    openDialog("Change password", session?.user?.email || "", `
      <form id="f-changepw" class="stack" novalidate>
        <label class="field"><span>New password (at least 10 characters)</span><input name="a" type="password" autocomplete="new-password" minlength="10" required /></label>
        <label class="field"><span>Repeat new password</span><input name="b" type="password" autocomplete="new-password" minlength="10" required /></label>
        <p class="msg" id="changepw-msg" hidden></p>
        <button class="btn" type="submit">Update password</button>
      </form>`);
  }
  async function saveChangedPassword(e) {
    e.preventDefault();
    const f = new FormData(e.target), a = String(f.get("a")), b = String(f.get("b"));
    if (a.length < 10) { showMsg("#changepw-msg", "Use at least 10 characters.", "bad"); return; }
    if (a !== b) { showMsg("#changepw-msg", "The two passwords don't match.", "bad"); return; }
    const btn = e.target.querySelector("button");
    busy(btn, true, "Saving…");
    try {
      await authed((t) => auth("user", { method: "PUT", body: { password: a }, token: t }));
      closeDialog(); toast("Password updated.");
    } catch (ex) { showMsg("#changepw-msg", S.friendly(ex), "bad"); busy(btn, false); }
  }

  // ==================================================================
  //  Events
  // ==================================================================
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action], [data-tab]");
    if (!el || el.disabled) return;
    if (el.dataset.tab) { switchTab(el.dataset.tab); return; }
    const a = el.dataset.action;
    const actions = {
      "show-forgot": () => { showAuth("forgot"); $("#forgot-email").value = $("#login-email").value; },
      "show-login": () => showAuth("login"),
      "cancel-newpw": () => showAuth("login"),
      logout: () => signOut(),
      "change-pw": changePasswordDialog,
      chip: () => { B.filter = el.dataset.chip; renderBookings(); },
      open: () => openBooking(el.dataset.id),
      "dlg-close": closeDialog,
      "set-status": () => setStatus(el, el.dataset.status),
      "record-pay": () => recordPayment(el),
      refunded: () => markRefunded(el),
      "save-notes": () => saveNotes(el),
      delete: () => deleteBooking(el),
      doc: () => downloadDoc(el),
      "new-booking": newBookingDialog,
      export: exportCsv,
      "load-more": () => loadBookings(true),
      "add-room": addRoom,
      "discard-room": () => { el.closest("form").remove(); if (!R.rows.length && !$("#rooms-list form")) renderRooms(); },
      "delete-room": () => deleteRoom(el.closest("form")),
      "add-location": addLocation,
      "discard-location": () => { el.closest("form").remove(); if (!Lc.rows.length && !$("#locations-list form")) renderLocations(); },
      "delete-location": () => deleteLocation(el.closest("form")),
    };
    if (actions[a]) actions[a]();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#dlg").hidden) closeDialog();
    if (e.key === "Enter" && e.target.matches("tr[data-action=open]")) openBooking(e.target.dataset.id);
  });
  $("#dlg").addEventListener("click", (e) => { if (e.target.id === "dlg") closeDialog(); });
  document.addEventListener("submit", (e) => {
    const id = e.target.id;
    if (id === "f-login") doLogin(e);
    else if (id === "f-forgot") doForgot(e);
    else if (id === "f-newpw") doNewPassword(e);
    else if (id === "f-manual") saveManual(e);
    else if (id === "f-settings") saveSettings(e);
    else if (id === "f-changepw") saveChangedPassword(e);
    else if (e.target.matches("form.room-edit")) saveRoom(e);
    else if (e.target.matches("form.loc-edit")) saveLocation(e);
  });
  $("#loc-filter").addEventListener("change", (e) => { B.loc = e.target.value; renderBookings(); });
  $("#search").addEventListener("input", (e) => { B.q = e.target.value.trim(); renderBookings(); });
  $("#pay-filter").addEventListener("change", (e) => { B.pay = e.target.value; renderBookings(); });
  $("#sort").addEventListener("change", (e) => { B.sort = e.target.value; renderBookings(); });

  // Refresh the bookings list every 2 minutes while the tab is open and idle.
  setInterval(() => {
    if (!document.hidden && session && !$("#app").hidden && !$("#panel-bookings").hidden && $("#dlg").hidden) loadBookings();
  }, 120000);

  // ==================================================================
  //  Start
  // ==================================================================
  (async function init() {
    S.applyTheme();
    $$("[data-brand]").forEach((el) => { el.textContent = CFG.brand?.name || "Admin"; });
    document.title = `Admin · ${CFG.brand?.name || ""}`;
    if (!S.configured()) {
      showAuth("login");
      showMsg("#login-err", "Not set up yet: fill in supabase.url and supabase.key in config.js (see README).", "bad");
      $("#login-btn").disabled = true;
      return;
    }
    if (await handleAuthRedirect()) return;
    restoreSession();
    if (session) {
      try { if (await isAdmin()) { await showApp(); return; } } catch { /* fall through */ }
      saveSession(null);
    }
    showAuth("login");
  })();
})();
