/* Local test mode: served only by tests/local/server.mjs, never deployed.
   Loaded after js/common.js and before site.js / admin.js. It:
     1. accepts this server's http://localhost address (config.js normally insists on https://),
     2. shows photos uploaded to this server,
     3. replaces Razorpay's checkout with a fake payment window,
     4. shows a "local test mode" bar with the sample owner login. */
(function () {
  "use strict";
  const S = window.Stay;
  const L = window.__LOCAL || {};
  if (!S) return;

  // 1. This server is plain http on your own computer.
  S.configured = () => true;

  // 2. Photos uploaded here are served from http://localhost:<port>/storage/…
  const photo = new RegExp(`^http://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${Number(L.port)}/storage/v1/object/public/room-images/[\\w.-]+$`);
  const safeUrl = S.safeUrl;
  S.safeUrl = (u, fallback = "") => { const s = String(u ?? "").trim(); return photo.test(s) ? s : safeUrl(u, fallback); };
  S.cssUrl = (u) => { const s = S.safeUrl(u); return s ? `url("${s.replace(/["\\\n\r]/g, "")}")` : "none"; };

  // 3. Fake Razorpay checkout.
  const loadScript = S.loadScript;
  S.loadScript = (src) => (/^https:\/\/checkout\.razorpay\.com\//.test(src) ? Promise.resolve() : loadScript(src));

  const el = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
  const BTN = "display:block;width:100%;margin:8px 0 0;padding:12px 14px;border-radius:8px;font:600 15px system-ui,sans-serif;cursor:pointer;";

  window.Razorpay = class FakeRazorpay {
    constructor(options) { this.o = options || {}; this.failed = []; }
    on(event, fn) { if (event === "payment.failed" && typeof fn === "function") this.failed.push(fn); }
    open() {
      const o = this.o;
      const shade = el("div", "position:fixed;inset:0;z-index:2147483646;background:rgba(20,24,14,.6);display:flex;align-items:center;justify-content:center;padding:16px;");
      const box = el("div", "background:#fff;color:#2F3522;max-width:380px;width:100%;border-radius:14px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.35);font:15px/1.45 system-ui,sans-serif;");
      box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-label", "Fake payment window");
      box.append(
        el("div", "font:700 12px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#8A6D3B;", "Fake payment · local test mode"),
        el("div", "font:700 26px system-ui,sans-serif;margin:6px 0 2px;", S.inr(o.amount)),
        el("div", "color:#6B7280;font-size:13px;", `${o.description || ""}`),
        el("div", "color:#6B7280;font-size:13px;margin-bottom:8px;", `Order ${o.order_id || "?"} · no real money moves`),
      );
      const msg = el("p", "margin:8px 0 0;font-size:13px;color:#B42318;min-height:0;");
      const pay = el("button", BTN + "border:0;background:#5C6544;color:#fff;", "Pay successfully");
      const fail = el("button", BTN + "border:1px solid #DDE2CE;background:#fff;color:#2F3522;", "Make the payment fail");
      const close = el("button", BTN + "border:1px solid #DDE2CE;background:#fff;color:#2F3522;", "Close without paying");
      [pay, fail, close].forEach((b) => { b.type = "button"; });
      box.append(pay, fail, close, msg);
      shade.append(box);
      document.body.append(shade);
      pay.focus();
      const done = () => shade.remove();

      pay.addEventListener("click", async () => {
        pay.disabled = fail.disabled = close.disabled = true;
        pay.textContent = "Paying…";
        try {
          const res = await fetch("/__local/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order_id: o.order_id }) });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || res.status);
          done();
          if (typeof o.handler === "function") o.handler(data);
        } catch (e) {
          msg.textContent = `The fake payment didn't go through (${e.message}).`;
          pay.disabled = fail.disabled = close.disabled = false;
          pay.textContent = "Pay successfully";
        }
      });
      fail.addEventListener("click", () => {
        msg.textContent = "Card declined (test). You can try again or close.";
        this.failed.forEach((fn) => fn({ error: { code: "BAD_REQUEST_ERROR", description: "Card declined (local test)", reason: "payment_failed" } }));
      });
      close.addEventListener("click", () => { done(); if (o.modal && typeof o.modal.ondismiss === "function") o.modal.ondismiss(); });
    }
  };

  // 4. The "local test mode" bar.
  const bar = el("div", "position:fixed;left:0;right:0;bottom:0;z-index:2147483645;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;justify-content:center;padding:8px 44px 8px 12px;background:#2F3522;color:#fff;font:13px/1.4 system-ui,sans-serif;text-align:center;");
  bar.setAttribute("role", "note");
  bar.append(el("b", "color:#D1AE76;", "Local test mode"), el("span", "", "Data is fake and resets when the server stops."));
  const link = (href, text) => { const a = el("a", "color:#fff;", text); a.href = href; return a; };
  const login = document.getElementById("login-email");
  if (login && L.owner) {
    bar.append(el("span", "", `Sample owner: ${L.owner.email} / ${L.owner.password}`));
    const fill = el("button", "padding:3px 10px;border-radius:6px;border:1px solid #D1AE76;background:transparent;color:#fff;font:600 12px system-ui,sans-serif;cursor:pointer;", "Fill in");
    fill.type = "button";
    fill.addEventListener("click", () => {
      login.value = L.owner.email;
      const pw = document.getElementById("login-pw"); if (pw) pw.value = L.owner.password;
      const go = document.getElementById("login-btn"); if (go) go.focus();
    });
    bar.append(fill);
  } else {
    bar.append(link("admin.html", "Owner login"));
  }
  const mail = link("/__local/emails", "Emails sent"); mail.target = "_blank"; mail.rel = "noopener";
  bar.append(mail);
  const hide = el("button", "position:absolute;right:8px;top:50%;transform:translateY(-50%);width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:#fff;font:16px system-ui,sans-serif;cursor:pointer;", "✕");
  hide.type = "button"; hide.setAttribute("aria-label", "Hide the local test mode bar");
  hide.addEventListener("click", () => { bar.remove(); document.body.style.paddingBottom = ""; });
  bar.append(hide);
  document.body.append(bar);
  document.body.style.paddingBottom = "48px";
})();
