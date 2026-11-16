# Product Legal Fact Sheet — Dhyana Stays booking website

> Version: 1 · Last updated: 2026-11-15 · Prepared by: Claude (aruzen-legal-studio) · Reviewed by: pending
> Source tags: [code: path:line] [config: file] [vendor doc] [founder stated] [assumed — confirm]
>
> This is the data registry (record of processing) for Dhyana Stays. The terms and conditions, privacy policy and consent notice are drafted from it, so keep it current: update it whenever the website, a vendor or an offline process changes.
>
> Code state recorded: branch `to-add` on 2026-11-15, including uncommitted work. Line numbers refer to that state.

## 1. Entity and roles

| Item | Value | Source |
|---|---|---|
| Operating entity (legal name, type, reg. no.) | **[PLACEHOLDER — legal name]**, a private limited company or LLP registered in India. CIN / LLPIN: **[PLACEHOLDER]** | [founder stated: "Private limited / LLP"; name not given] |
| Trading name | Dhyana Stays | [config: web/config.js:24] |
| Registered address | **[PLACEHOLDER]** | open question |
| Tax IDs (GSTIN / VAT) | **[PLACEHOLDER]**. The site can show a business GSTIN and a GSTIN per location; GST is off by default | [code: supabase/setup.sql:75-76, 110] |
| Role for user data | **The client entity above is the Data Fiduciary** for all guest data (DPDP Act 2023). Supabase, Cloudflare and Resend act as its Data Processors. Razorpay is likely an independent fiduciary for payment data (see §5) | [founder stated: client build] |
| Client build? | **Yes — Aruzen client build.** Aruzen designs and builds the website; the client owns every account (Supabase, Cloudflare, Razorpay, Resend). Aruzen gets access to live guest data **only when the client asks for support**, and then acts as a Data Processor for the client | [founder stated] |
| Privacy / DPO contact | Same as Grievance Officer (below) until a separate contact is named | [assumed — confirm] |
| Grievance Officer (India) | **[PLACEHOLDER — name, designation, email, postal address]**. The founder chose a named person; name not yet supplied | [founder stated] |
| EU / UK representative (Art. 27) | Not required: no EU/UK targeting (see §3, §14) | [founder stated: India only] |

## 2. Product and audience

- **Description:** a direct-booking website for wellness stays in Auroville (near Pondicherry, Tamil Nadu) and other locations in India. Guests browse stays, search and filter by location and price, view photos and videos, choose dates, and then (a) pay online through Razorpay, (b) reserve and pay on arrival (dates held for 24 hours pending the owner's confirmation), or (c) send an inquiry for price-on-request stays. The owner runs bookings, rooms, locations, contact details, GST and booking rules from an admin dashboard. [code: web/js/site.js; web/js/admin.js; supabase/setup.sql]
- **Surfaces:** public website (`web/index.html`), owner admin dashboard (`web/admin.html`, login only), booking server (Supabase Edge Function `supabase/functions/booking-api/index.ts`), transactional emails. No mobile app. No guest accounts: guests book without signing up. [code]
- **B2C / B2B:** B2C (holiday and wellness accommodation for consumers). [founder stated; code]
- **Minimum age; children likely?** No age gate and no age field. Rooms are described for adults and children ("2 Adults + 1 Child") [code: supabase/setup.sql:132], so **children stay**, but only the lead guest's details are collected online. **Children's personal data is collected offline** when foreign children are included in Form C reports and if their IDs are copied (§4 row 11). Minimum age for the lead booker is not stated anywhere → open question (recommend 18+).
- **Marketplace? Seller of record:** **A mix** [founder stated]. Some stays are operated by Dhyana Stays itself (Dhyana Stays is the seller). Others belong to partner property owners and Dhyana Stays takes bookings for them, which makes it a **marketplace e-commerce entity** for those stays. Who the seller of record is for partner stays, what guest data partners receive and how they are paid out are **not in the code** → open questions. Today every receipt or invoice is issued in the single business name from admin → Settings [code: web/js/common.js invoiceHTML; supabase/setup.sql:89-92].

## 3. Markets

| Market | Active targeting? | Users (approx.) | Language | Pricing currency |
|---|---|---|---|---|
| India | Yes | Pre-launch (none yet) | English only [code: web/index.html `lang="en"`] | INR (₹) only [code: supabase/functions/booking-api/index.ts:199 `currency: "INR"`] |
| Foreign visitors (Auroville draws many) | **No active targeting** [founder stated] | Incidental | English | INR |

Note: foreign nationals do stay (Form C reporting is planned [founder stated]), so the documents must work for them, but EU/UK/US law is not triggered by incidental bookings alone (§14).

## 4. Data inventory

Lead guest = the person who fills in the booking form. Legal-basis candidates use DPDP Act 2023 terms (consent, s.6; legitimate uses, s.7) and, during the transition, IT Act s.43A / SPDI Rules 2011. Counsel must confirm.

| # | Data category | Fields | Source | Purpose | Legal-basis candidates | Required? | Recipients | Storage location | Retention (period or trigger) | Sensitive? | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Lead guest identity and contact | Full name, email, phone | User (booking form; or owner types it in for phone bookings) | Make and manage the booking; confirmations; contact about the stay; anti-abuse limits (max 3 live holds per email or phone) | DPDP s.7(a) voluntary provision for a specified purpose, or consent via the booking notice | Yes (form refuses without them) | Owner/admins; Supabase; Resend (emails); Razorpay (pre-filled at checkout); partner owner for partner stays [assumed — confirm] | Supabase Postgres, Mumbai `ap-south-1` [assumed — confirm: project not created yet; README recommends it] | **No deletion today** (kept until manually deleted). Proposed: paid/invoiced bookings 8 years after the financial year ends; unpaid, expired, cancelled and inquiry records 12 months after check-out or expiry | No | [code: web/index.html:195-199; web/js/site.js:628-633, 652; supabase/setup.sql:167-169, 446-454; web/js/admin.js:469-505] |
| 2 | Stay details | Room, location, check-in, check-out, number of rooms, number of guests, booking reference, status, source, hold expiry, price breakdown | User choices + system | Fulfil the booking; availability; pricing | Same as row 1 | Yes | Owner/admins; Supabase; Resend (emails); partner owner for partner stays [assumed — confirm] | Supabase (as row 1) | As row 1 | No | [code: supabase/setup.sql:156-177] |
| 3 | Special requests | Free text, up to 1,000 characters | User (optional) | Meet guest needs | Consent (optional field with notice) | No | Owner/admins; Resend (in emails to guest and owner) | Supabase | As row 1 | **Possibly**: the placeholder invites "Dietary needs", so guests may disclose health (allergies), religious or disability information | [code: web/index.html:201; supabase/setup.sql:170; supabase/functions/booking-api/index.ts:268-269] |
| 4 | Payment and transaction records | Amounts (subtotal, GST, total), payment status and method, Razorpay order and payment IDs, paid-at time, invoice number and date | System + Razorpay | Take payment; verify it; receipts and tax invoices; refunds; accounting | Contract/s.7(a); legal obligation (GST, income tax) → s.8(7) allows retention needed for compliance with law | Yes for online bookings | Owner/admins; Razorpay; Supabase; accountant via CSV export | Supabase | Proposed: 8 years after the financial year ends [assumed — confirm with CA: CGST Act s.36 (72 months from the annual-return due date) and Income-tax rules] | No. **Card and UPI details never reach this system**: entered only in Razorpay's checkout | [code: supabase/setup.sql:173-185; web/js/site.js:670-690; supabase/functions/booking-api/index.ts:195-199, 347, 363-380] |
| 5 | Owner's private notes on a booking | Free text, up to 4,000 characters | Owner/admins | Operations (e.g. a guest's arrival arrangements) | Same as the booking it belongs to | No | Owner/admins only (row-level security) | Supabase | With its booking | Possibly, depending on what staff write: needs a staff guideline | [code: web/js/admin.js:407-408; supabase/setup.sql:186, 722] |
| 6 | Network address (IP) | Raw IP (transient); stored only as a salted SHA-256 hash cut to 32 hex characters | Derived from each booking request | Anti-abuse: max 6 live holds and 12 requests per hour per network; bot check | Consent via notice / s.7(a) [assumed — confirm: DPDP has no "legitimate interests" basis] | Automatic | Supabase (hash stored); Cloudflare Turnstile (raw IP sent for verification) | Supabase (hash); raw IP also in Supabase and Cloudflare request logs (§5) | Hash: **no deletion today**. Proposed: clear after 90 days. Vendor logs: per vendor (§5) | No (pseudonymous, still personal data) | [code: supabase/functions/booking-api/index.ts:130-132, 211-219, 333-335; supabase/setup.sql:187, 196, 455-462, 268-270 (hash never returned to guests)] |
| 7 | Bot-check signals | Turnstile token; browser and device signals collected by Cloudflare's widget | Cloudflare Turnstile in the guest's browser | Stop automated fake bookings | Consent via notice / s.7(a) [assumed — confirm] | Yes once Turnstile is switched on | Cloudflare | Cloudflare (global) | Per Cloudflare [vendor doc — verify] | No | [code: web/js/site.js:605-615; supabase/functions/booking-api/index.ts:211-219] [founder stated: on at launch] |
| 8 | Booking emails | Copies of rows 1–4 (name, email, phone, dates, room, total, requests) in confirmation emails to the guest and the owner | System | Confirm bookings; tell the owner a booking needs action | Same as row 1 | Yes for email confirmations | Resend; guest's and owner's mailbox providers | Resend [vendor doc — verify region]; owner's inbox | Resend: per Resend's log retention [vendor doc — verify]. Owner inbox: owner's own policy → open question | No | [code: supabase/functions/booking-api/index.ts:236-243, 260-306] [founder stated: on at launch] |
| 9 | Owner and staff admin accounts | Email, password (stored hashed by Supabase Auth), login sessions, sign-in and password-reset records | Owner/staff | Secure access to the dashboard | Employment / contract; SPDI Rules (passwords are SPDI) | Yes | Supabase Auth; email provider for reset links | Supabase; session token kept in the browser tab's sessionStorage (`stay_admin_session`), gone when the tab closes | Until the admin is removed | Password = SPDI under the 2011 Rules | [code: supabase/setup.sql:123-125; web/js/admin.js:12, 30-60, 127, 150] |
| 10 | Messages outside the website | Phone calls, WhatsApp messages, emails to the support address; details the owner enters as phone bookings | User | Answer questions; take bookings by phone | s.7(a) / consent | No | Owner/staff; Meta (WhatsApp) when the guest chooses WhatsApp; email provider | Owner's phone, WhatsApp, mailbox; phone bookings go into Supabase (row 1) | Open question | Possibly | [code: web/js/site.js:52-75 (tel:, wa.me and mailto: links); web/js/admin.js:469-505 (manual bookings)] |
| 11 | **Check-in identity records (offline)** | Copies of government photo ID of every adult guest; for foreign nationals, Form C details (passport and visa details, nationality, arrival/departure, address and contact) | User, at the property | Verify identity; report foreign guests as the law requires | Legal obligation → DPDP s.7(d); ID copies of Indian guests → consent / s.7(a) [assumed — confirm] | ID: yes per house rules. Form C: yes for foreign nationals | Owner/staff; Bureau of Immigration (Form C portal); police on lawful request | **Unknown: paper, phone photos or files?** → open question | Open question (not stated anywhere) | **Yes: government IDs, passport data, possibly children's data**. Aadhaar copies have extra legal limits (masking) [assumed — confirm] | [config: web/config.js:84 "Valid photo ID required for all adult guests at check-in"] [founder stated: copies kept + Form C] — **no code** |
| 12 | Partner property owners | Name, contact, property details; bank details for payouts (likely) | Partners | Run partner stays; pay owners | Contract | — | Owner/admins; accountant; bank | **Not in this system** → open question | Open question | Bank details = SPDI (financial info) | [founder stated: mix of own and partner stays] — no code |
| 13 | Business contact details shown on the site | Phone numbers, WhatsApp number, emails, address, opening hours (may include staff members' personal numbers) | Owner | Let guests reach the business | Contract / staff consent | — | Public (website, emails, invoices) | Supabase `settings` | Until changed | No | [code: supabase/setup.sql:66-92; web/js/site.js:52-75; supabase/functions/booking-api/index.ts:246-258] |
| 14 | Room photos and videos | Images and videos uploaded by the owner; may show identifiable people (staff, guests) | Owner | Show the stays | Consent of anyone identifiable [assumed — confirm] | — | Public (website); Supabase Storage | Supabase Storage bucket `room-images` (public) | Until removed; removed files are deleted from storage on save | Only if people are recognisable | [code: web/js/admin.js (media manager); supabase/setup.sql storage section] |

**Not collected:** no guest accounts or passwords, no date of birth, no address from guests online, no card or bank details (Razorpay handles those), no location tracking (`geolocation=()` is blocked [config: web/_headers:9]), no analytics, no advertising, no profiling, no data bought from third parties, no sale or "sharing" of data.

### 4a. Collection points (where the privacy notice and consent must appear)

| Collection point | What is collected | Notice/consent shown today | Needed |
|---|---|---|---|
| Booking form, website [code: web/index.html:191-210] | Rows 1–3, 6, 7 | **None**: no privacy notice, no terms link, no checkbox [code: grep finds no "privacy", "terms" or "consent" in web/] | Short notice at the form with links to the privacy policy and terms; an unticked box to accept the terms and cancellation policy (not pre-ticked) |
| Razorpay checkout | Card/UPI details (by Razorpay) | Razorpay's own | Mention Razorpay in the notice |
| Phone, WhatsApp and email bookings [code: web/js/admin.js:469] | Rows 1–3, 10 | None | A sentence the owner can read or send, plus the link to the privacy policy |
| Check-in at the property | Row 11 | None | Printed or digital notice at check-in (ID purpose, Form C, retention); separate consent for keeping ID copies where law doesn't require them |
| Footer, every page [code: web/index.html:147-152] | — | No legal links | Links to Privacy policy, Terms, Cancellation & refunds, Grievance Officer |

## 5. Processors, sub-processors and other recipients

| Vendor | Function | Data shared | Location | Contract/DPA in place? | Trains on data? | Evidence |
|---|---|---|---|---|---|---|
| Supabase | Database, admin login, file storage, booking server (Edge Functions), request logs | All rows 1–9, 13, 14; raw IPs and user agents in API logs | Database: Mumbai `ap-south-1` [assumed — confirm]. Edge Functions run on Supabase's global network and may run outside India [vendor doc — verify] | Supabase DPA: open question (client signs in its own account) | No [vendor doc — verify] | [code: supabase/setup.sql; supabase/functions/booking-api/index.ts:159] [README.md:85] |
| Cloudflare | Website hosting and CDN (Pages); Turnstile bot check; cdnjs (PDF libraries, loaded only when a guest downloads a receipt) | Raw IP and browser data for every page view; Turnstile signals; IP on receipt download | Global network | Cloudflare DPA: open question | No [vendor doc — verify] | [config: web/_headers] [code: web/js/site.js:608; web/js/common.js:343-344] |
| Razorpay | Online payments | Amount, booking ID and reference (order notes); guest name, email and phone (pre-filled in checkout); card/UPI details entered by the guest | India | Merchant agreement. Razorpay is a regulated payment aggregator and **probably an independent Data Fiduciary for payment data**, not a processor [assumed — confirm] | Per Razorpay policy [vendor doc — verify] | [code: supabase/functions/booking-api/index.ts:195-199, 347; web/js/site.js:670-690] |
| Resend | Sending booking emails | Rows 1–4 and 8 in email bodies; recipient addresses | US company; sending region selectable [vendor doc — verify] | Resend DPA: open question | No [vendor doc — verify] | [code: supabase/functions/booking-api/index.ts:236-243] [founder stated: on at launch] |
| Google (Google Fonts) | Web fonts, loaded on every page | Guest's IP address and browser details (no cookies, per Google [vendor doc — verify]) | US / global | None (no contract) | — | [code: web/js/common.js:211; web/index.html:27-28] |
| Meta (WhatsApp) | Only when a guest chooses to message on WhatsApp | Whatever the guest sends | Global | Not a processor: the guest's own choice of channel | — | [code: web/js/site.js:65] |
| Aruzen | Builds the site; support when the client asks | Any data visible during support sessions | **[PLACEHOLDER — Aruzen location]** | **Needed:** a written support and data-processing agreement between the client and Aruzen | No | [founder stated: client owns accounts; support access on request] |
| Partner property owners | Run partner stays | Guest details for their bookings [assumed — confirm] | India | **Needed:** partner agreement covering data | — | [founder stated] |
| Bureau of Immigration / police | Form C reporting; lawful requests | Row 11 for foreign nationals | India | Legal obligation | — | [founder stated] |
| Owner's email and phone providers | Owner receives booking emails and messages | Rows 1–4, 8, 10 | Unknown | Open question | — | [code: supabase/functions/booking-api/index.ts:291-306 (OWNER_EMAIL)] |
| GitHub | Stores the website's code | No guest data. Contact details in `config.js` (business phone and email) | US | — | — | [README.md] |

No vendor receives data for its own marketing, and no data is sold or shared for targeted advertising [code: no ad or analytics scripts in web/].

## 6. International transfers

| From | To | Data | Mechanism (adequacy / SCCs / IDTA / UK Addendum / DPDP permitted) | Evidence |
|---|---|---|---|---|
| India | US (Resend) | Booking email contents | DPDP s.16: transfers allowed except to countries the government restricts by notification (none known to restrict the US) [assumed — confirm current notifications] | [code: index.ts:236-243] |
| India | Global (Cloudflare, Google Fonts) | IP, browser data, bot-check signals | DPDP s.16 as above | [code: common.js:211; site.js:608] |
| India | Possibly outside India (Supabase Edge Functions, logs) | Booking requests in transit | DPDP s.16 as above | [vendor doc — verify] |

No EU/UK-origin transfers apply, because there's no EU/UK establishment or targeting.

## 7. Cookies and trackers

| Name | Provider | Purpose category | Duration | Loads before consent? | Evidence |
|---|---|---|---|---|---|
| *(none set by the site)* | Dhyana Stays | — | — | — | [code: no `document.cookie` or `localStorage` in web/js] |
| `stay_admin_session` (sessionStorage) | Dhyana Stays (admin page only) | Strictly necessary: keeps the owner logged in | Until the tab closes | Yes (admin only, not guests) | [code: web/js/admin.js:12, 38-40] |
| Razorpay Checkout script and frame | Razorpay | Strictly necessary for payment; Razorpay may set its own cookies or device identifiers for fraud prevention [vendor doc — verify] | Per Razorpay | Loads only when the guest clicks Pay | [code: web/js/site.js:670] |
| Cloudflare Turnstile widget | Cloudflare | Security (bot check) | Per Cloudflare [vendor doc — verify whether it sets cookies] | Loads when the booking dialog opens | [code: web/js/site.js:605-615] |
| Google Fonts requests | Google | Functional (fonts); IP disclosed to Google, no cookies [vendor doc — verify] | — | Yes, on every page | [code: web/js/common.js:211] |
| Cloudflare edge cookies (e.g. `__cf_bm`) | Cloudflare | Security, only if bot protection is enabled on the domain | Up to 30 minutes [vendor doc — verify] | Yes if enabled | [assumed — confirm Cloudflare settings] |

No analytics, advertising pixels, session replay or chat widgets [code: no gtag/fbq/hotjar/clarity etc.]. A cookie banner is therefore not needed for India today; a short cookie section in the privacy policy is enough. Self-hosting the fonts would remove the Google disclosure.

## 8. Children

- **Age gate:** none. **Verifiable parental consent flow:** none. **Child-directed features:** none; the site isn't aimed at children. **Behavioural ads to minors:** no ads at all.
- Children stay with their families (room capacities mention children [code: supabase/setup.sql:132]). Online, only the number of guests is collected, not children's names. Offline, foreign children's passport details go into Form C, and children's IDs may be copied (row 11).
- **Recommendation for drafting:** require the lead booker to be 18+ and to confirm they act for everyone in the party. Treat children's data at check-in as collected for a legal obligation, and avoid copying children's IDs unless required.

## 9. AI and automated decision-making

| Feature | Model / provider | User data sent | Provider retention / training | Automated decision with significant effect? | Synthetic media produced? | Human review? |
|---|---|---|---|---|---|---|
| None | — | — | — | No. Pricing is a fixed rate card (weekday/weekend + GST slabs); anti-abuse limits refuse some booking attempts automatically (max holds per email/phone/network), which guests can work around by contacting the owner | **Marketing images on the site are computer-generated illustrations** [README.md:142], not photos of the stays | Pay-on-arrival requests are confirmed by a person [code: supabase/setup.sql:495-496; web/js/admin.js] |

Drafting note: under consumer law, images must not be passed off as photos of the actual property (misleading advertisement risk under the Consumer Protection Act 2019). Replace them with real photos, or label them as illustrations, before launch.

## 10. Payments, pricing, subscriptions, refunds

- **Payment provider(s):** Razorpay (card, UPI, etc. in Razorpay's checkout) [code: web/js/site.js:670]; or pay on arrival (cash, UPI, card, bank, other recorded by the owner) [code: supabase/setup.sql:174].
- **Fees shown upfront incl. mandatory charges:** the price per night is shown on cards; the booking form shows a server-calculated quote (nights × rate, weekend rate on configured weekend nights, GST lines when enabled) and the total on the Pay button before payment [code: web/js/site.js quote; supabase/setup.sql compute_quote]. No booking or convenience fees in the code.
- **Taxes:** GST off by default. When on: 2025 accommodation slabs (up to ₹1,000 exempt; up to ₹7,500 at 5%; above at 18%), CGST/SGST on the invoice, place of supply = the location's state [code: supabase/setup.sql gst_rate_for, compute_quote].
- **Subscriptions / auto-renew / free trials:** none. **Renewal reminders / cancellation path:** not applicable.
- **Holds:** online payment holds the dates 30 minutes; pay on arrival holds 24 hours pending the owner's confirmation; inquiries hold nothing [code: supabase/setup.sql:81-82, 495-496].
- **Refund / cancellation policy:** the site shows **sample text**: "Free cancellation up to 7 days before check-in. 50% refund up to 48 hours before. No refund after that." [config: web/config.js:82], marked "replace with your real policy". **No online cancellation exists**: guests must contact the owner, who cancels in the admin page and refunds by hand in Razorpay, then clicks "Mark refunded" [code: web/js/admin.js:430-440]. Refund timelines are not stated anywhere → open question.
- **Late payment edge case:** if a payment arrives after the hold lapsed and the dates were taken, the booking is flagged "needs attention" and the guest is told they'll be contacted for other dates or a full refund [code: web/js/site.js showDone; supabase/setup.sql confirm_payment].
- **Marketplace payouts:** partner owners are paid offline; not in the code → open question (including the GST treatment of partner stays booked through Dhyana Stays as an e-commerce operator, for the CA).
- **Receipts and invoices:** a numbered receipt or tax invoice per financial year (e.g. DS/26-27/0001), downloadable as PDF by the guest and owner [code: supabase/setup.sql next_invoice_no; web/js/common.js invoiceHTML].

## 11. User content and marketplace roles

- **UGC types:** guests post nothing public. Their only free text is "special requests", visible to the owner only. Owners upload room photos and videos and write descriptions.
- **Moderation / notice-and-takedown:** not needed for guest content. For partner stays, partner-supplied photos and descriptions are published by Dhyana Stays itself (no self-service partner login) [code: only admins can write rooms — supabase/setup.sql rooms policies].
- **Reviews:** none on the site (so no review-authenticity duties today).
- **Seller/host verification:** partner owners are onboarded offline → open question (needed for the E-Commerce Rules' seller-information duties).

## 12. Security measures

- **Encryption:** HTTPS everywhere with HSTS [config: web/_headers:5]; Supabase encrypts data at rest [vendor doc — verify].
- **Access control:** row-level security on every table, so the public can only read active rooms, locations and settings [code: supabase/setup.sql policies]; admins are listed in an `admins` table; the server's secret key never reaches browsers; payments verified by Razorpay signature (HMAC) and a signed webhook [code: index.ts]. **No multi-factor authentication for the admin login** (finding). Password minimum 10 characters [README.md setup guide].
- **Abuse protection:** per-guest and per-network booking limits, honeypot field, optional Turnstile, input checks in the database [code: supabase/setup.sql:446-462; web/index.html:203].
- **Web hardening:** strict Content Security Policy, frame blocking, no-referrer on the admin page [config: web/_headers]. Third-party scripts (PDF libraries, Razorpay, Turnstile) load without integrity hashes (finding from the status report).
- **Logging & monitoring:** server logs record error messages only, no guest details [code: index.ts:135, 144, 243, 423]; vendors keep request logs with IPs (§5).
- **Backups:** Supabase daily backups depend on the plan [vendor doc — verify]; no other backups.
- **Testing:** 235 automated checks (database rules, booking server, website, admin).
- **Incident response owner:** **[PLACEHOLDER]** → open question. DPDP will require breach notice to the Data Protection Board and affected people.

## 13. Rights fulfilment capability

| Right | Available? | How (self-serve / email / admin tool) | SLA |
|---|---|---|---|
| Access / export | Partly | By request to the Grievance Officer; the owner can export bookings as CSV and download the booking PDF [code: web/js/admin.js:528-540] | Not set → open question |
| Correction | **Gap** | Admins can't edit a guest's name, email or phone in the dashboard (only private notes) [code: supabase/setup.sql:722]; needs the Supabase dashboard | Not set |
| Deletion / erasure | Partly | Admin can delete unpaid bookings with no invoice [code: supabase/setup.sql:657-665]; paid/invoiced bookings must be kept for tax law; **no anonymisation tool**; **no automatic deletion** | Not set |
| Withdraw consent | By email | No marketing exists; withdrawal of consent for the booking itself → treat as a deletion request, subject to legal retention | Not set |
| Object / opt out (sale, sharing, targeted ads, profiling) | Not applicable | No sale, sharing, ads or profiling | — |
| Nominate (India DPDP) | By email | Manual: Grievance Officer records the nominee | Not set |
| Grievance redressal | Placeholder | Named Grievance Officer **[PLACEHOLDER]**; then the Data Protection Board of India | Not set |

## 14. Jurisdiction trigger map

| Regime | Applies? | Why (fact ref) | Status / commencement | Confidence |
|---|---|---|---|---|
| India — DPDP Act 2023 + DPDP Rules 2025 | **Yes** | Indian entity processing guests' digital personal data (§1, §4) | Rules notified Nov 2025; Board in force; substantive duties (notice, consent, security, breach, children, retention) from ~13–14 May 2027. Draft to DPDP now | High |
| India — IT Act s.43A + SPDI Rules 2011 | **Yes** | Body corporate; privacy policy required on the website; holds SPDI (admin passwords; partner bank details if stored) | In force until DPDP fully commences | High |
| India — Consumer Protection Act 2019 + E-Commerce Rules 2020 | **Yes** | Selling accommodation to consumers online; **inventory e-commerce entity** for own stays and **marketplace e-commerce entity** for partner stays (§2) | In force | High |
| India — Dark Patterns Guidelines 2023 | **Yes** | Online service to Indian consumers. Today's hold timers reflect real holds, not false urgency | In force | High |
| India — GST and income-tax record retention | **Yes** if GST-registered (and books of account in any case) | Receipts and invoices issued (§10) | In force | Medium (confirm with CA) |
| India — immigration reporting of foreign guests (Form C) | **Yes** | Foreign guests stay; Form C filed [founder stated] | In force [assumed — confirm the current statute and rules with counsel] | Medium |
| India — Aadhaar Act limits on storing Aadhaar copies | **Possibly** | ID copies kept at check-in; guests may hand over Aadhaar (§4 row 11) | In force [assumed — confirm] | Medium |
| India — IT Intermediary Rules 2021 | **Unlikely** | No third-party user content is published; partners don't self-list (§11). Revisit if partners or guests can post | In force | Medium |
| UK GDPR / EU GDPR, PECR / ePrivacy | **No** | No UK/EU establishment, no targeting (India only, INR, English), no monitoring (no analytics). Incidental foreign guests don't trigger Art. 3(2) | — | Medium: changes if marketing to Europe/UK starts |
| UK / EU consumer law, DSA, EAA | **No** | Same reason | — | Medium |
| US federal and state privacy law, COPPA | **No** | No US targeting; not child-directed | — | High |

Law-status register verified 19 Oct 2026, under 90 days ago, so no re-verification needed now. Re-check DPDP commencement dates before the policies are finalised for launch.

## 15. Open questions

Top five blocking drafting:
1. **Legal entity details:** exact registered name, CIN/LLPIN, registered address, GSTIN, and whether the same entity operates every location.
2. **Grievance Officer:** name, designation, email and postal address (also the privacy contact and breach-response owner?).
3. **Partner stays:** Dhyana Stays' role (agent or reseller), who the seller of record is, what guest data partners receive, partner agreements, payouts, and invoicing/GST treatment (for the CA).
4. **Real cancellation and refund policy:** tiers, timelines for refunds to the original payment method, no-show rules, and whether partner stays follow the same policy.
5. **Check-in IDs and Form C:** how ID copies are stored (paper, phone photos, files), who can see them, how long they're kept, whether Aadhaar copies are masked, and whether children's IDs are copied.

Also needed:
6. Retention periods: confirm the proposals in §4 (paid records 8 years; other booking records 12 months; IP hashes 90 days), then build automatic deletion.
7. Minimum age for the lead booker (recommend 18+) and the "books on behalf of the party" statement.
8. Supabase project region (Mumbai recommended) and plan (backups); Resend sending region.
9. Data processing agreements: Supabase, Cloudflare and Resend (in the client's accounts); a support and data-processing agreement between the client and Aruzen, plus Aruzen's legal entity and location.
10. Owner's handling of booking emails, WhatsApp and phone notes: who has access and how long they are kept.
11. Will there ever be marketing emails or offers? Today there are none; if added, they need separate opt-in consent.
12. Any existing documents to reuse (policies, partner contracts, house rules)?
13. Rights-request timelines (e.g. reply within 30 days) and who handles them.
14. Is "Support every day, 24×7" accurate? (Shown as a highlight and contact hours.)

## 16. DRIFT items (description vs. code)

| # | Founder/doc says | Code shows | Evidence | Resolution owner |
|---|---|---|---|---|
| 1 | Booking emails will be on at launch | `emailConfirmations: false`, so the site doesn't promise emails; the server sends them only once Resend secrets are set | [config: web/config.js:101] [founder stated] | Owner/Aruzen: set the Resend secrets and switch `emailConfirmations` to `true` before launch, so the privacy policy matches |
| 2 | Turnstile will be on at launch | `turnstileSiteKey: ""`, so it's off | [config: web/config.js:104] | Owner/Aruzen: add the site key and `TURNSTILE_SECRET` |
| 3 | The entity is a private limited company or LLP | Receipts and invoices print the business name from Settings, seeded as "Dhyana Stays" (a trading name) | [code: supabase/setup.sql:89-92; web/js/common.js invoiceHTML] | Owner: enter the registered legal name in admin → Settings |
| 4 | Site shows a cancellation policy (7 days free / 50% to 48 h / none after) | It's sample text; no code applies these tiers; cancellations and refunds are manual | [config: web/config.js:82; web/js/admin.js:430-440] | Owner: confirm the real policy; terms must describe the manual process |
| 5 | Site says guests must show photo ID at check-in | ID copies are kept and Form C is filed, but nothing on the site tells guests | [config: web/config.js:84] [founder stated] | Owner: disclose in the privacy policy and at check-in |
| 6 | Code comments and the README say the booking server stores only a salted hash of the IP | True for the database, but raw IPs remain in Supabase and Cloudflare request logs | [code: index.ts:333-335] [vendor doc] | Drafting: the policy must not say "we never store your IP address" |
| 7 | Hero, about and banner images suggest real stays | They are computer-generated illustrations | [README.md:142] | Owner: replace with real photos or label them |
| 8 | Site and emails present no legal documents | No privacy policy, terms, cancellation page or Grievance Officer details exist, which the E-Commerce Rules and SPDI Rules require | [code: no such pages in web/] | Aruzen: add the pages and footer links once drafted |

---

*This fact sheet records facts for drafting. It is not legal advice. A qualified lawyer in India (and in any other market you later target) must review the documents built from it before they are published.*
