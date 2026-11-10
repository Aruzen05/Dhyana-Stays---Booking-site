/* Public website: content from config.js, rooms + availability from Supabase,
   bookings through the booking-api edge function. */
(function () {
  "use strict";
  const S = window.Stay;
  const CFG = S.CFG;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;

  const state = {
    rooms: [], locations: [], locFilter: "",
    settings: { allow_pay_on_arrival: true, max_nights: 30, booking_window_days: 365, arrival_hold_hours: 24 },
    roomId: null, avail: {}, availLoading: false, today: S.todayIn(CFG.timezone),
    calY: 0, calM: 0, pick: 0, ci: null, co: null, units: 1, guests: 2,
    quote: null, quoteSeq: 0, busy: false, captcha: "", captchaId: null, lastBooking: null, returnFocus: null,
  };
  const room = () => state.rooms.find((r) => r.id === state.roomId) || null;
  const get = (path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), CFG);

  // ================================================================
  //  Page content from config.js
  // ================================================================
  function renderContent() {
    $$("[data-text]").forEach((el) => {
      const v = get(el.dataset.text);
      el.textContent = v == null ? "" : String(v);
      if (!v && el.tagName === "P") el.hidden = true;
    });
    const hero = $(".hero");
    hero.style.backgroundImage = S.cssUrl(CFG.hero?.image);
    hero.setAttribute("aria-label", CFG.hero?.imageAlt || "");
    setImg($("#about-img"), CFG.about?.image, CFG.about?.imageAlt);
    setImg($("#banner-img"), CFG.banner?.image, CFG.banner?.imageAlt);

    $("#highlights").innerHTML = (CFG.highlights || [])
      .map((h) => `<li><span class="hl-icon" aria-hidden="true">${S.esc(h.icon)}</span><span>${S.esc(h.label)}</span></li>`).join("");

    const p = CFG.policies || {};
    $("#pol-times").innerHTML = `Check-in from <b>${S.esc(p.checkIn || "—")}</b><br>Check-out by <b>${S.esc(p.checkOut || "—")}</b>`;
    $("#pol-rules").innerHTML = (p.rules || []).map((r) => `<li>${S.esc(r)}</li>`).join("");

    const logo = S.safeUrl(CFG.brand?.logo);
    $$(".brand-mark").forEach((img) => { if (logo) img.src = logo; else img.remove(); });
    renderContact();
  }

  // Contact details come from admin → Settings (falls back to config.js if the DB is unreachable).
  function renderContact() {
    const c = S.contact();
    let wa = String(c.whatsapp || c.phones[0] || "").replace(/\D/g, "");
    if (wa.length === 10) wa = "91" + wa;                       // wa.me needs the country code
    const cards = [];
    if (c.address.length || S.safeUrl(c.mapUrl)) {
      cards.push(`<div class="card contact-card"><div class="contact-icon" aria-hidden="true">📍</div><h3>Find us</h3>
        ${c.address.map((l) => `<p>${S.esc(l)}</p>`).join("")}
        ${S.safeUrl(c.mapUrl) ? `<p><a href="${S.esc(S.safeUrl(c.mapUrl))}" target="_blank" rel="noopener">Open in Maps ↗</a></p>` : ""}</div>`);
    }
    if (c.phones.length || wa.length >= 11) {
      cards.push(`<div class="card contact-card"><div class="contact-icon" aria-hidden="true">📞</div><h3>Call us</h3>
        ${c.phones.map((n) => `<p><a href="${S.esc(S.telHref(n))}">${S.esc(n)}</a></p>`).join("")}
        ${wa.length >= 11 ? `<p><a href="https://wa.me/${S.esc(wa)}" target="_blank" rel="noopener">WhatsApp ↗</a></p>` : ""}
        ${c.hours ? `<p class="muted">${S.esc(c.hours)}</p>` : ""}</div>`);
    }
    const emails = c.emails.filter((e) => EMAIL_RE.test(e));
    if (emails.length) {
      cards.push(`<div class="card contact-card"><div class="contact-icon" aria-hidden="true">✉️</div><h3>Email</h3>
        ${emails.map((e) => `<p><a href="mailto:${S.esc(e)}">${S.esc(e)}</a></p>`).join("")}</div>`);
    }
    $("#contact-grid").innerHTML = cards.join("") || `<p class="rooms-msg">Contact details will appear here soon.</p>`;
    $("#footer-line").textContent = [`© ${new Date().getFullYear()} ${CFG.brand?.name || ""}`, c.address.join(", ")].filter(Boolean).join(" · ");
  }

  function setImg(img, src, alt) {
    const s = S.safeUrl(src);
    if (s) { img.src = s; img.alt = alt || ""; } else img.closest("section, div").classList.add("no-img");
  }

  // Search engines: the brand as an Organization, each location as its own LodgingBusiness.
  function renderStructuredData() {
    const c = S.contact(), b = CFG.brand || {};
    const site = String(b.siteUrl || "").replace(/\/+$/, "");
    const abs = (p) => (/^https:/.test(p || "") ? p : site && p ? `${site}/${p}` : undefined);
    const offer = (r) => ({ "@type": "Offer", name: r.name, description: r.description || undefined,
      ...(r.price_per_night ? { price: r.price_per_night, priceCurrency: "INR" } : {}) });
    const org = {
      "@type": "Organization", "@id": `${site}/#org`, name: b.name, url: site || undefined, logo: abs(b.logo),
      email: c.emails[0], telephone: c.phones[0],
      address: c.address.length ? { "@type": "PostalAddress", streetAddress: c.address.join(", "), addressCountry: "IN" } : undefined,
    };
    const places = state.locations.filter((l) => state.rooms.some((r) => r.location_id === l.id)).map((l) => ({
      "@type": "LodgingBusiness", name: `${b.name} — ${l.name}`, description: l.description || b.tagline, url: site ? `${site}/#stay` : undefined,
      image: abs(CFG.hero?.image), telephone: c.phones[0], email: c.emails[0], parentOrganization: { "@id": `${site}/#org` },
      address: { "@type": "PostalAddress", streetAddress: (l.address_lines || []).join(", ") || undefined, addressLocality: l.city || l.name,
                 addressRegion: l.state, postalCode: l.postal_code || undefined, addressCountry: "IN" },
      ...(l.latitude && l.longitude ? { geo: { "@type": "GeoCoordinates", latitude: Number(l.latitude), longitude: Number(l.longitude) } } : {}),
      checkinTime: CFG.policies?.checkIn, checkoutTime: CFG.policies?.checkOut, currenciesAccepted: "INR",
      makesOffer: state.rooms.filter((r) => r.location_id === l.id).map(offer),
    }));
    const s = document.createElement("script");
    s.type = "application/ld+json";
    s.textContent = JSON.stringify({ "@context": "https://schema.org", "@graph": [org, ...places] }).replace(/</g, "\\u003c");
    document.head.appendChild(s);
  }

  // ================================================================
  //  Rooms
  // ================================================================
  async function loadData() {
    if (!S.configured()) {
      console.warn("[stay] Fill in supabase.url and supabase.key in config.js");
      roomsMessage();
      return;
    }
    try {
      const [rooms, settings, locations] = await Promise.all([
        S.rest("rooms?select=id,location_id,name,capacity_label,max_guests,description,features,price_per_night,weekend_price,max_units,image_url,sort_order&is_active=eq.true&order=sort_order.asc,name.asc"),
        S.rest("settings?select=allow_pay_on_arrival,max_nights,booking_window_days,arrival_hold_hours,timezone,contact_phones,contact_whatsapp,contact_emails,contact_address,contact_map_url,contact_hours").catch(() => []),
        S.rest("locations?select=id,name,area_label,description,address_lines,city,state,postal_code,map_url,latitude,longitude&is_active=eq.true&order=sort_order.asc,name.asc").catch(() => []),
      ]);
      state.locations = Array.isArray(locations) ? locations : [];
      const order = (id) => { const i = state.locations.findIndex((l) => l.id === id); return i < 0 ? 999 : i; };
      // Rooms in a hidden location stay hidden; list rooms grouped by location order.
      state.rooms = (Array.isArray(rooms) ? rooms : [])
        .filter((r) => !r.location_id || state.locations.some((l) => l.id === r.location_id))
        .map((r, i) => ({ ...r, _i: i })).sort((a, b) => order(a.location_id) - order(b.location_id) || a._i - b._i);
      if (Array.isArray(settings) && settings[0]) { Object.assign(state.settings, settings[0]); S.setContact(settings[0]); renderContact(); }
      if (state.settings.timezone) state.today = S.todayIn(state.settings.timezone);
      renderRooms();
      renderStructuredData();
    } catch (e) {
      console.error("[stay] could not load rooms", e);
      roomsMessage();
    }
  }

  function roomsMessage() {
    const phone = S.contact().phones[0];
    $("#rooms").innerHTML = `<p class="rooms-msg">Our rooms couldn't be loaded just now.${phone ? ` Please call <a href="${S.esc(S.telHref(phone))}">${S.esc(phone)}</a> to book.` : ""}</p>`;
  }
  const locById = (id) => state.locations.find((l) => l.id === id) || null;
  // Locations that actually have rooms on the site
  const usedLocations = () => state.locations.filter((l) => state.rooms.some((r) => r.location_id === l.id));

  function priceLine(r) {
    if (!r.price_per_night) return `<p class="room-price muted">Price on request</p>`;
    if (r.weekend_price && r.weekend_price !== r.price_per_night) {
      return `<p class="room-price">${S.inrRupees(r.price_per_night)} <span>weekdays</span> · ${S.inrRupees(r.weekend_price)} <span>weekends</span></p>`;
    }
    return `<p class="room-price">${S.inrRupees(r.price_per_night)} <span>/ night</span></p>`;
  }

  function renderRooms() {
    if (!state.rooms.length) {
      $("#loc-tabs").innerHTML = $("#loc-intro").innerHTML = "";
      $("#rooms").innerHTML = `<p class="rooms-msg">No rooms are open for booking right now. Please contact us.</p>`;
      return;
    }
    const locs = usedLocations();
    if (state.locFilter && !locs.some((l) => l.id === state.locFilter)) state.locFilter = "";
    // Location tabs — only when stays exist in more than one place
    $("#loc-tabs").innerHTML = locs.length > 1 ? `<div class="loc-tabs" role="tablist" aria-label="Locations">
        <button type="button" role="tab" class="loc-tab${state.locFilter ? "" : " active"}" aria-selected="${!state.locFilter}" data-action="loc" data-loc="">All stays <span>${state.rooms.length}</span></button>
        ${locs.map((l) => `<button type="button" role="tab" class="loc-tab${state.locFilter === l.id ? " active" : ""}" aria-selected="${state.locFilter === l.id}" data-action="loc" data-loc="${S.esc(l.id)}">${S.esc(l.name)} <span>${state.rooms.filter((r) => r.location_id === l.id).length}</span></button>`).join("")}
      </div>` : "";
    const focus = state.locFilter ? locById(state.locFilter) : locs.length === 1 ? locs[0] : null;
    $("#loc-intro").innerHTML = focus ? `<div class="loc-intro">
        <h3>${S.esc(focus.name)}${focus.area_label ? ` <span>· ${S.esc(focus.area_label)}</span>` : ""}</h3>
        ${focus.description ? `<p>${S.esc(focus.description)}</p>` : ""}
        <p class="muted">${S.esc([...(focus.address_lines || []), focus.state].filter(Boolean).join(", "))}${S.safeUrl(focus.map_url) ? ` · <a href="${S.esc(S.safeUrl(focus.map_url))}" target="_blank" rel="noopener">Map ↗</a>` : ""}</p>
      </div>` : "";

    const list = state.locFilter ? state.rooms.filter((r) => r.location_id === state.locFilter) : state.rooms;
    const fallback = "images/placeholder-room.svg";
    $("#rooms").innerHTML = list.map((r) => {
      const loc = locById(r.location_id);
      return `
      <article class="room-card">
        <div class="room-media"><img src="${S.esc(S.safeUrl(r.image_url, fallback))}" alt="${S.esc(r.name)}" loading="lazy" /></div>
        <div class="room-body">
          ${loc && locs.length > 1 ? `<p class="room-loc">📍 ${S.esc(S.locationLine(loc))}</p>` : ""}
          <div class="room-head"><h3>${S.esc(r.name)}</h3>${r.capacity_label ? `<span class="pill">${S.esc(r.capacity_label)}</span>` : ""}</div>
          ${priceLine(r)}
          ${r.description ? `<p class="room-desc">${S.esc(r.description)}</p>` : ""}
          ${(r.features || []).length ? `<ul class="room-features">${r.features.map((f) => `<li>${S.esc(f)}</li>`).join("")}</ul>` : ""}
          <button type="button" class="btn btn-full" data-action="book" data-room="${S.esc(r.id)}">${r.price_per_night ? "Book this room" : "Ask about this room"}</button>
        </div>
      </article>`;
    }).join("");
  }

  // ================================================================
  //  Booking dialog
  // ================================================================
  function openBooking(roomId) {
    state.returnFocus = document.activeElement;
    resetForm();
    $("#booking").hidden = false;
    document.body.classList.add("modal-open");
    renderRoomOptions();
    if (roomId && state.rooms.some((r) => r.id === roomId)) selectRoom(roomId);
    else if (state.rooms.length === 1) selectRoom(state.rooms[0].id);
    else renderCalendar();
    setupCaptcha();
    setTimeout(() => ($(".room-option.selected") || $(".room-option") || $(".modal-close")).focus(), 30);
  }

  function closeBooking() {
    if (state.busy) return;
    $("#booking").hidden = true;
    document.body.classList.remove("modal-open");
    if (state.returnFocus && state.returnFocus.focus) state.returnFocus.focus();
  }

  function resetForm() {
    Object.assign(state, { roomId: null, avail: {}, pick: 0, ci: null, co: null, units: 1, guests: 2, quote: null, busy: false, lastBooking: null });
    const t = S.parseYMD(state.today);
    state.calY = t.y; state.calM = t.m;
    ["#bk-name", "#bk-email", "#bk-phone", "#bk-requests", "#bk-company"].forEach((id) => { $(id).value = ""; });
    $("#bk-form").hidden = false;
    $("#bk-done").hidden = true;
    $("#bk-title").textContent = "Reserve your stay";
    hideError(); calNote("");
    renderSteppers(); renderQuote(); renderButtons();
  }

  function renderRoomOptions() {
    if (!state.rooms.length) {
      $("#bk-rooms").innerHTML = `<p class="cal-msg">Rooms couldn't be loaded. Please contact us to book.</p>`;
      return;
    }
    const multi = usedLocations().length > 1;
    let lastLoc = null;
    $("#bk-rooms").innerHTML = state.rooms.map((r) => {
      const head = multi && r.location_id !== lastLoc ? `<div class="ro-group">📍 ${S.esc(S.locationLine(locById(r.location_id)) || "Other")}</div>` : "";
      lastLoc = r.location_id;
      return `${head}
      <button type="button" class="room-option${r.id === state.roomId ? " selected" : ""}" role="radio" aria-checked="${r.id === state.roomId}" data-action="room" data-room="${S.esc(r.id)}">
        <span class="ro-thumb" style="background-image:${S.esc(S.cssUrl(S.safeUrl(r.image_url, "images/placeholder-room.svg")))}"></span>
        <span class="ro-text"><b>${S.esc(r.name)}</b><small>${S.esc(r.capacity_label || "")}${r.price_per_night ? ` · from ${S.inrRupees(Math.min(r.price_per_night, r.weekend_price || r.price_per_night))}/night` : " · price on request"}</small></span>
        <span class="ro-dot" aria-hidden="true"></span>
      </button>`;
    }).join("");
  }

  async function selectRoom(id) {
    state.roomId = id;
    state.pick = 0; state.ci = null; state.co = null; state.quote = null; state.units = 1;
    state.guests = Math.min(state.guests, room().max_guests);
    renderRoomOptions(); renderSteppers(); renderQuote(); renderButtons(); calNote("");
    state.availLoading = true; renderCalendar();
    const until = S.addDays(state.today, Math.min(400, Number(state.settings.booking_window_days) || 365) + 1);
    try {
      const rows = await S.rpc("get_availability", { p_room_id: id, p_from: state.today, p_to: until });
      if (state.roomId !== id) return;
      state.avail = {};
      (rows || []).forEach((r) => { state.avail[r.night] = r.booked; });
    } catch (e) {
      console.error("[stay] availability", e);
      calNote("We couldn't load availability. You can still choose dates — we'll check them when you book.");
    }
    state.availLoading = false;
    renderCalendar();
  }

  // ---------- calendar ----------
  const lastBookable = () => S.addDays(state.today, Number(state.settings.booking_window_days) || 365);
  const freeOn = (d) => (room()?.max_units || 1) - (state.avail[d] || 0);
  function rangeFree(ci, co, units = state.units) {
    for (let d = ci; d < co; d = S.addDays(d, 1)) if (freeOn(d) < units) return false;
    return true;
  }
  function minFreeInRange(ci, co) {
    let min = Infinity;
    for (let d = ci; d < co; d = S.addDays(d, 1)) min = Math.min(min, freeOn(d));
    return min === Infinity ? room()?.max_units || 1 : min;
  }

  function renderCalendar() {
    const el = $("#bk-cal");
    const r = room();
    if (!r) { el.innerHTML = `<p class="cal-msg">Choose a room above to see available dates.</p>`; return; }
    if (state.availLoading) { el.innerHTML = `<p class="cal-msg">Loading availability…</p>`; return; }

    const t = S.parseYMD(state.today), last = lastBookable(), l = S.parseYMD(last);
    const { calY: y, calM: m } = state;
    const first = S.ymd(y, m, 1);
    const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const canPrev = y > t.y || (y === t.y && m > t.m);
    const canNext = y < l.y || (y === l.y && m < l.m);

    let html = `<div class="cal-head">
        <button type="button" class="cal-nav" data-action="cal-prev" ${canPrev ? "" : "disabled"} aria-label="Previous month">‹</button>
        <span class="cal-month" aria-live="polite">${S.MONTHS[m - 1]} ${y}</span>
        <button type="button" class="cal-nav" data-action="cal-next" ${canNext ? "" : "disabled"} aria-label="Next month">›</button>
      </div><div class="cal-grid" role="grid">${S.DOW.map((d) => `<span class="cal-dow" aria-hidden="true">${d}</span>`).join("")}`;
    for (let i = 0; i < S.dayOfWeek(first); i++) html += `<span></span>`;

    for (let d = 1; d <= daysIn; d++) {
      const date = S.ymd(y, m, d);
      const out = date < state.today || date > last;
      const free = freeOn(date);
      const asCheckout = state.pick === 1 && date > state.ci && rangeFree(state.ci, date);
      const clickable = !out && (free >= state.units || asCheckout);
      let cls = out ? "out" : free <= 0 ? "full" : free < r.max_units ? "partial" : "avail";
      if (!out && free < state.units && free > 0) cls = "full";
      if (date === state.ci || date === state.co) cls += " sel";
      else if (state.ci && state.co && date > state.ci && date < state.co) cls += " range";
      if (date === state.today) cls += " today";
      if (asCheckout) cls += " can-out";
      const status = out ? "not bookable" : free <= 0 ? "fully booked" : `${free} of ${r.max_units} free`;
      html += `<button type="button" class="day ${cls}" data-action="day" data-date="${date}" ${clickable ? "" : "disabled"} aria-label="${S.esc(S.fmtDate(date, true))}, ${status}" aria-pressed="${date === state.ci || date === state.co}">${d}</button>`;
    }
    html += `</div>`;

    let msg = "Select your check-in date";
    if (state.pick === 1) msg = `Check-in <b>${S.esc(S.fmtDate(state.ci))}</b> — now select check-out`;
    if (state.pick === 2) msg = `<b>${S.esc(S.fmtDate(state.ci))}</b> → <b>${S.esc(S.fmtDate(state.co))}</b> · ${S.plural(S.nightsBetween(state.ci, state.co), "night")}`;
    html += `<p class="cal-pick">${msg}</p><div class="cal-legend"><span><i class="lg-avail"></i>Available</span>${r.max_units > 1 ? `<span><i class="lg-partial"></i>Few left</span>` : ""}<span><i class="lg-full"></i>Booked</span></div>`;
    el.innerHTML = html;
  }

  function pickDay(date) {
    calNote("");
    hideError();
    const maxN = Number(state.settings.max_nights) || 30;
    if (state.pick !== 1 || date <= state.ci) {
      if (freeOn(date) < state.units) return;
      state.ci = date; state.co = null; state.pick = 1; state.quote = null;
    } else {
      const n = S.nightsBetween(state.ci, date);
      if (n > maxN) { calNote(`Stays of up to ${maxN} nights can be booked online — contact us for longer stays.`); return; }
      if (!rangeFree(state.ci, date)) {
        calNote("Some nights in that range are already booked. Please pick a new check-in date.");
        state.pick = 0; state.ci = null;
      } else {
        state.co = date; state.pick = 2;
        refreshQuote();
      }
    }
    renderCalendar(); renderSteppers(); renderQuote(); renderButtons();
  }

  function calNav(dir) {
    state.calM += dir;
    if (state.calM < 1) { state.calM = 12; state.calY--; }
    if (state.calM > 12) { state.calM = 1; state.calY++; }
    renderCalendar();
  }

  // ---------- rooms / guests ----------
  function maxUnitsNow() {
    const r = room();
    if (!r) return 1;
    return state.ci && state.co ? Math.max(1, Math.min(r.max_units, minFreeInRange(state.ci, state.co))) : r.max_units;
  }
  function renderSteppers() {
    const r = room();
    const group = $("#bk-units-group");
    group.hidden = !r || r.max_units <= 1;
    $("#bk-units").textContent = state.units;
    const mu = maxUnitsNow();
    $("[data-action='units-']").disabled = state.units <= 1;
    $("[data-action='units+']").disabled = state.units >= mu;
    $("#bk-units-note").textContent = r && r.max_units > 1 ? (state.ci && state.co ? `${mu} free for your dates` : `up to ${r.max_units}`) : "";
    const mg = r ? r.max_guests * state.units : 10;
    state.guests = Math.min(Math.max(1, state.guests), mg);
    $("#bk-guests").textContent = state.guests;
    $("[data-action='guests-']").disabled = state.guests <= 1;
    $("[data-action='guests+']").disabled = state.guests >= mg;
    $("#bk-guests-note").textContent = r ? `max ${mg}${state.units > 1 ? ` for ${state.units} rooms` : ""}` : "";
  }
  function changeUnits(d) {
    const next = Math.min(maxUnitsNow(), Math.max(1, state.units + d));
    if (next === state.units) return;
    state.units = next;
    if (state.ci && state.co && !rangeFree(state.ci, state.co)) { state.co = null; state.pick = state.ci ? 1 : 0; state.quote = null; }
    renderSteppers(); renderCalendar(); renderButtons();
    if (state.co) refreshQuote(); else renderQuote();
  }
  function changeGuests(d) { state.guests += d; renderSteppers(); }

  // ---------- quote (always from the server) ----------
  async function refreshQuote() {
    const r = room();
    if (!r || !state.ci || !state.co) return;
    if (!r.price_per_night) { state.quote = { priced: false }; renderQuote(); renderButtons(); return; }
    const seq = ++state.quoteSeq;
    state.quote = { loading: true };
    renderQuote(); renderButtons();
    try {
      const q = await S.rpc("quote_stay", { p_room_id: r.id, p_check_in: state.ci, p_check_out: state.co, p_units: state.units });
      if (seq !== state.quoteSeq) return;
      state.quote = q;
    } catch (e) {
      if (seq !== state.quoteSeq) return;
      state.quote = null;
      showError(S.friendly(e));
    }
    renderQuote(); renderButtons();
  }

  function renderQuote() {
    const el = $("#bk-quote");
    const q = state.quote;
    if (!q) { el.hidden = true; return; }
    el.hidden = false;
    if (q.loading) { el.innerHTML = `<p class="muted">Calculating price…</p>`; return; }
    if (!q.priced) { el.innerHTML = `<p><b>Price on request.</b> Send an inquiry and we'll reply with a quote — no payment needed now, and the dates are not held.</p>`; return; }
    const groups = [];
    for (const n of q.nightly) {
      const g = groups.find((x) => x.tariff === n.tariff && x.weekend === n.weekend);
      if (g) g.count++; else groups.push({ tariff: n.tariff, weekend: n.weekend, count: 1 });
    }
    const hasWeekendRate = new Set(q.nightly.map((n) => n.tariff)).size > 1;
    const unitsTxt = q.units > 1 ? ` × ${q.units} rooms` : "";
    let rows = groups.map((g) => `<div class="q-row"><span>${S.plural(g.count, hasWeekendRate ? (g.weekend ? "weekend night" : "weekday night") : "night")}${unitsTxt} × ${S.inrRupees(g.tariff)}</span><span>${S.inr(g.count * g.tariff * q.units * 100)}</span></div>`).join("");
    if (q.gst_paise > 0) {
      const rates = [...new Set(q.nightly.map((n) => n.gst_rate).filter(Boolean))].join("% / ");
      rows += `<div class="q-row q-tax"><span>GST (${rates}%)</span><span>${S.inr(q.gst_paise)}</span></div>`;
    }
    rows += `<div class="q-row q-total"><span>Total</span><span>${S.inr(q.total_paise)}</span></div>`;
    el.innerHTML = rows;
  }

  function renderButtons() {
    const r = room();
    const q = state.quote;
    const ready = !!(r && state.ci && state.co && q && !q.loading);
    const priced = !!(r && r.price_per_night);
    const pay = $("#bk-pay"), arr = $("#bk-arrival"), inq = $("#bk-inquiry");
    pay.hidden = !priced;
    arr.hidden = !priced || !state.settings.allow_pay_on_arrival;
    inq.hidden = !r || priced;
    const total = ready && q.priced ? S.inr(q.total_paise) : "";
    pay.textContent = total ? `Pay ${total} now` : "Pay online";
    arr.textContent = total ? `Reserve now · pay ${total} on arrival` : "Reserve · pay on arrival";
    [pay, arr, inq].forEach((b) => { b.disabled = state.busy || !ready; });

    const p = CFG.policies || {};
    const hold = Number(state.settings.arrival_hold_hours) || 24;
    $("#bk-policy").innerHTML = [
      p.checkIn || p.checkOut ? `Check-in ${S.esc(p.checkIn || "")} · check-out ${S.esc(p.checkOut || "")}.` : "",
      p.cancellation ? `<b>Cancellation:</b> ${S.esc(p.cancellation)}` : "",
      priced && state.settings.allow_pay_on_arrival ? `Pay-on-arrival requests are held for ${hold} hours while we confirm them.` : "",
      `By booking you agree to our <a href="#policies" data-action="close">stay policies</a>.`,
    ].filter(Boolean).join(" ");
  }

  // ---------- errors ----------
  function showError(msg) { const el = $("#bk-error"); el.textContent = msg; el.hidden = false; el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  function hideError() { $("#bk-error").hidden = true; }
  function calNote(msg) { const el = $("#bk-cal-note"); el.textContent = msg; el.hidden = !msg; }

  // ---------- captcha (optional) ----------
  async function setupCaptcha() {
    if (!CFG.turnstileSiteKey) return;
    try {
      await S.loadScript("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
      if (state.captchaId !== null) { window.turnstile.reset(state.captchaId); state.captcha = ""; return; }
      state.captchaId = window.turnstile.render("#bk-captcha", {
        sitekey: CFG.turnstileSiteKey,
        callback: (t) => { state.captcha = t; },
        "expired-callback": () => { state.captcha = ""; },
      });
    } catch (e) { console.error("[stay] captcha", e); }
  }
  function resetCaptcha() { if (state.captchaId !== null && window.turnstile) { window.turnstile.reset(state.captchaId); state.captcha = ""; } }

  // ================================================================
  //  Submit
  // ================================================================
  function collect() {
    return {
      name: $("#bk-name").value.trim(), email: $("#bk-email").value.trim(),
      phone: $("#bk-phone").value.trim(), requests: $("#bk-requests").value.trim(), company: $("#bk-company").value,
    };
  }
  function validate(v) {
    if (!room()) return "Please choose a room.";
    if (!state.ci || !state.co) return "Please choose your check-in and check-out dates.";
    if (!v.name) return "Please enter your name.";
    if (!EMAIL_RE.test(v.email)) return "Please enter a valid email address.";
    if (!PHONE_RE.test(v.phone)) return "Please enter a valid phone number (digits, spaces and + only).";
    if (CFG.turnstileSiteKey && !state.captcha) return "Please complete the “I'm human” check.";
    return "";
  }
  function setBusy(on, label) {
    state.busy = on;
    renderButtons();
    $(".modal-close").disabled = on;
    if (on && label) { const b = { online: "#bk-pay", arrival: "#bk-arrival", inquiry: "#bk-inquiry" }[label]; if (b) $(b).textContent = label === "online" ? "Opening secure payment…" : "Sending…"; }
  }

  async function submit(mode) {
    if (state.busy) return;
    hideError();
    const v = collect();
    const problem = validate(v);
    if (problem) { showError(problem); return; }
    setBusy(true, mode);
    try {
      const res = await S.bookingApi("create", {
        room_id: state.roomId, check_in: state.ci, check_out: state.co, units: state.units, guests: state.guests,
        mode: mode === "inquiry" ? "online" : mode, name: v.name, email: v.email, phone: v.phone, requests: v.requests,
        company: v.company, captcha: state.captcha,
      });
      resetCaptcha();
      if (res.payment) await pay(res, v);
      else showDone(res.booking);
    } catch (e) {
      resetCaptcha();
      showError(S.friendly(e));
      if (e.code === "not_available") { const id = state.roomId; setBusy(false); await selectRoom(id); return; }
    }
    setBusy(false);
  }

  async function pay(res, v) {
    try {
      await S.loadScript("https://checkout.razorpay.com/v1/checkout.js");
    } catch {
      showError("The payment window couldn't load. Check your connection, or choose pay on arrival.");
      return;
    }
    const b = res.booking, p = res.payment;
    await new Promise((resolve) => {
      const rzp = new window.Razorpay({
        key: p.key_id, order_id: p.order_id, amount: p.amount, currency: p.currency,
        name: CFG.brand?.name || "", description: `${b.room_name} · ${S.plural(S.nightsBetween(b.check_in, b.check_out), "night")}`,
        prefill: { name: v.name, email: v.email, contact: v.phone },
        notes: { booking_ref: b.ref }, theme: { color: CFG.theme?.primary || "#2F6B4F" },
        timeout: 900, retry: { enabled: true },
        handler: (resp) => { verify(resp, b).finally(resolve); },
        modal: {
          confirm_close: true,
          ondismiss: () => { showError("Payment was not completed. Your dates are held for a few minutes — you can try again."); resolve(); },
        },
      });
      rzp.on("payment.failed", (r) => { showError(`Payment failed: ${(r && r.error && r.error.description) || "please try another method."}`); });
      rzp.open();
    });
  }

  async function verify(resp, b) {
    $("#bk-form").hidden = true;
    const done = $("#bk-done");
    done.hidden = false;
    done.innerHTML = `<p class="done-icon" aria-hidden="true">⏳</p><p class="done-title">Confirming your payment…</p><p class="muted">Please don't close this window.</p>`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await S.bookingApi("verify", {
          razorpay_order_id: resp.razorpay_order_id, razorpay_payment_id: resp.razorpay_payment_id, razorpay_signature: resp.razorpay_signature,
        });
        showDone(r.booking);
        return;
      } catch (e) {
        if (e.status && e.status < 500) break;
        await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
      }
    }
    showDone({ ...b, status: "pending_confirmation", razorpay_payment_id: resp.razorpay_payment_id });
  }

  function showDone(b) {
    state.lastBooking = b;
    $("#bk-form").hidden = true;
    const el = $("#bk-done");
    el.hidden = false;
    const nights = S.nightsBetween(b.check_in, b.check_out);
    const stay = `${S.esc(b.room_name)}${b.num_units > 1 ? ` × ${b.num_units}` : ""}${b.location_name ? `, ${S.esc(b.location_name)}` : ""} · ${S.esc(S.fmtDate(b.check_in))} → ${S.esc(S.fmtDate(b.check_out))} · ${S.plural(nights, "night")}`;
    const email = CFG.emailConfirmations ? ` A confirmation email is on its way to <b>${S.esc(b.guest_email)}</b>.` : "";
    const phone = S.contact().phones[0] || "";
    let icon = "🌿", title = "", body = "", download = "";

    if (b.status === "confirmed" && b.payment_status === "paid") {
      title = "Booking confirmed!";
      $("#bk-title").textContent = "You're booked";
      body = `<p>Thank you, ${S.esc(b.guest_name)}. Your stay is confirmed and paid in full.${email}</p>
        <dl class="done-list"><dt>Booking ref</dt><dd>${S.esc(b.ref)}</dd><dt>Stay</dt><dd>${stay}</dd><dt>Paid</dt><dd>${S.inr(b.total_paise)}</dd><dt>Invoice</dt><dd>${S.esc(b.invoice_no || "—")}</dd></dl>`;
      download = "Download invoice (PDF)";
    } else if (b.payment_status === "paid" && b.needs_attention) {
      icon = "⚠️"; title = "Payment received — we'll be in touch";
      body = `<p>We received your payment, but the reservation timed out before it completed and the room was booked in the meantime. We're very sorry. We'll contact you shortly to offer other dates or a full refund.</p>
        <dl class="done-list"><dt>Booking ref</dt><dd>${S.esc(b.ref)}</dd><dt>Payment ID</dt><dd>${S.esc(b.razorpay_payment_id)}</dd></dl>`;
    } else if (b.status === "pending_confirmation") {
      icon = "✅"; title = "Payment received";
      body = `<p>Your payment went through. We're finishing the confirmation — it usually completes automatically within a few minutes.${email}</p>
        <dl class="done-list"><dt>Booking ref</dt><dd>${S.esc(b.ref)}</dd><dt>Payment ID</dt><dd>${S.esc(b.razorpay_payment_id)}</dd><dt>Stay</dt><dd>${stay}</dd></dl>
        <p class="muted">Keep the payment ID. If you don't hear from us within a day${phone ? `, call ${S.esc(phone)}` : ", contact us"}.</p>`;
    } else if (b.source === "inquiry") {
      title = "Inquiry sent";
      $("#bk-title").textContent = "Thank you";
      body = `<p>Thank you, ${S.esc(b.guest_name)}. We'll reply with pricing and availability for:</p><p><b>${stay}</b></p><p class="muted">No payment needed now. These dates are not held until we confirm.${email}</p>
        <dl class="done-list"><dt>Reference</dt><dd>${S.esc(b.ref)}</dd></dl>`;
    } else {
      title = "Request received";
      $("#bk-title").textContent = "Thank you";
      body = `<p>Thank you, ${S.esc(b.guest_name)}. We're holding these dates for you until <b>${S.esc(S.fmtDateTime(b.hold_expires_at))}</b> and will contact you to confirm.${email}</p>
        <dl class="done-list"><dt>Booking ref</dt><dd>${S.esc(b.ref)}</dd><dt>Stay</dt><dd>${stay}</dd><dt>Due on arrival</dt><dd>${S.inr(b.total_paise)}</dd></dl>`;
      download = "Download booking summary (PDF)";
    }
    el.innerHTML = `<p class="done-icon" aria-hidden="true">${icon}</p><p class="done-title">${S.esc(title)}</p>${body}
      ${download ? `<button type="button" class="btn btn-full" data-action="download">${download}</button>` : ""}
      <button type="button" class="btn btn-full btn-quiet" data-action="close">Done</button>`;
    $(".modal-close").disabled = false;
    state.busy = false;
  }

  async function download(btn) {
    if (!state.lastBooking) return;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Preparing PDF…";
    try { await S.downloadInvoice(state.lastBooking); }
    catch (e) { console.error(e); alert("Couldn't create the PDF. Please try again."); }
    btn.disabled = false; btn.textContent = label;
  }

  // ================================================================
  //  Events (no inline handlers — keeps the CSP strict)
  // ================================================================
  function toggleMenu(open) {
    const m = $("#mobile-menu"), btn = $(".hamburger");
    const show = open ?? m.hidden;
    m.hidden = !show;
    btn.setAttribute("aria-expanded", String(show));
    document.body.classList.toggle("menu-open", show);
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || el.disabled) return;
    const a = el.dataset.action;
    if (a === "book") { e.preventDefault(); toggleMenu(false); openBooking(el.dataset.room); }
    else if (a === "close") closeBooking();
    else if (a === "menu") toggleMenu();
    else if (a === "menu-close") toggleMenu(false);
    else if (a === "room") selectRoom(el.dataset.room);
    else if (a === "loc") { state.locFilter = el.dataset.loc || ""; renderRooms(); }
    else if (a === "day") pickDay(el.dataset.date);
    else if (a === "cal-prev") calNav(-1);
    else if (a === "cal-next") calNav(1);
    else if (a === "units-") changeUnits(-1);
    else if (a === "units+") changeUnits(1);
    else if (a === "guests-") changeGuests(-1);
    else if (a === "guests+") changeGuests(1);
    else if (a === "pay-online") submit("online");
    else if (a === "pay-arrival") submit("arrival");
    else if (a === "inquiry") submit("inquiry");
    else if (a === "download") download(el);
  });

  $("#booking").addEventListener("click", (e) => { if (e.target.id === "booking") closeBooking(); });

  document.addEventListener("keydown", (e) => {
    if ($("#booking").hidden) { if (e.key === "Escape") toggleMenu(false); return; }
    if (e.key === "Escape") { closeBooking(); return; }
    if (e.key === "Tab") {   // keep focus inside the dialog
      const f = $$("#booking button:not([disabled]), #booking input, #booking textarea, #booking a[href]").filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });

  window.addEventListener("scroll", () => $("#nav").classList.toggle("scrolled", window.scrollY > 40), { passive: true });

  // ---------- start ----------
  S.applyTheme();
  renderContent();
  loadData();
})();
