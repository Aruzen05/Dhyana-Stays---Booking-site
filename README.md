# Dhyana Stays — booking website (dhyanastays.com)

The public booking website for **Dhyana Stays**. Its home base is in Auroville, near Pondicherry, and it can list stays in **any number of locations**. Guests browse stays by location, pick free dates on a calendar, and then do one of three things: pay online (Razorpay), reserve and pay on arrival, or send an inquiry. The owner runs everything from `dhyanastays.com/admin.html`: bookings, rooms, locations, **contact details**, GST and booking rules.

This is a project of its own: its own Git repository, its own Supabase project and its own Cloudflare Pages site. It shares nothing with the La Palm Farms site, and nothing with the Dhyana Stays app (`D:\dhyana stays`) except the brand (logo, colours, fonts, wording).

It's plain HTML, CSS and JavaScript, with no build step. The data and security live in **Supabase**. Hosting is **Cloudflare Pages**, which publishes the site automatically every time a change is pushed to the repository.

```
dhyana-stays-website/
├── web/                      ← the website — this folder is what Cloudflare publishes
│   ├── config.js             ← brand text, colours, images, Supabase keys
│   ├── index.html            ← public site (link-preview text at the top, marked BRAND)
│   ├── admin.html            ← owner dashboard
│   ├── images/               ← logo.svg, og-image.jpg (link previews), your photos
│   ├── js/  css/             ← code (no need to edit)
│   └── _headers  robots.txt  sitemap.xml  favicon.svg
├── supabase/
│   ├── setup.sql             ← run once in Supabase (tables, rules, security)
│   └── functions/booking-api/index.ts   ← server code for bookings + payments
└── tests/                    ← optional automated tests (not uploaded anywhere)
```

**Where each thing is changed:**

| What | Where |
|---|---|
| Phone numbers, WhatsApp, emails, office address, map link, support hours | **admin → Settings → Contact details** (live straight away) |
| Locations (Auroville and any others): address, state, map, GSTIN | **admin → Locations** |
| Rooms, prices, photos and videos (and their order), which location each room is in | **admin → Rooms** |
| GST, invoice prefix, pay on arrival, hold times | **admin → Settings** |
| Brand wording, colours, hero/about text, policies | `web/config.js` |
| Link-preview title and description (WhatsApp, Google) | the `BRAND` block at the top of `web/index.html` |

---

## How it stays safe

| Risk | How it's handled |
|---|---|
| Someone reads guest names, emails and phones | The public key can't read bookings at all. Only logged-in admins can. |
| Someone pays ₹1 for a ₹6,000 stay | The **server** works out the price. Whatever the browser says is ignored. |
| Someone fakes "payment successful" | A booking is confirmed only when Razorpay's cryptographic signature checks out. |
| A guest closes the tab right after paying | Razorpay's webhook confirms the booking anyway. |
| Two guests book the last room at the same moment | The database itself refuses overlapping bookings of the same room unit. |
| Fake pay-on-arrival requests block the calendar | Holds expire after 24 hours unless you confirm them. Requests are capped per guest and per device. Optional bot check. |
| Someone changes your phone number or prices | Only logged-in admins can edit contact details, rooms, locations or settings. Phone numbers, emails and links are checked before saving. |
| Someone injects code through a name or room description | Every piece of text is escaped. A strict content security policy blocks unknown scripts. |
| Wrong GST charged | GST is worked out per room per night with the 2025 slabs, using the state of the room's location. It's off by default. A GSTIN from the wrong state is refused. |

---

## Try it on your computer first (no Supabase needed)

You can try the website and the owner dashboard on your own computer before setting anything up. You need [Node.js](https://nodejs.org) 22 or newer. In a terminal:

```
cd tests
npm install        # first time only
npm run local
```

Then open **<http://localhost:8787>**. The owner dashboard is at **<http://localhost:8787/admin.html>**.

| Login | Email | Password |
|---|---|---|
| Sample owner (admin) | `owner@example.com` | `test-owner-123` |
| Not an admin (should be refused) | `not-admin@example.com` | `not-admin-123` |

- **What's real:** the pages in `web/`, the database rules in `setup.sql` and the booking server code all run unchanged. Prices, availability, double-booking protection, invoices and admin permissions behave as they will on Supabase.
- **What's fake:** Razorpay opens a test window with "Pay successfully", "Make the payment fail" and "Close without paying". Emails aren't sent; read them at **<http://localhost:8787/__local/emails>**. "Forgot password" puts its reset link there too.
- **Sample places:** besides Auroville there's a sample Kodaikanal location with one room, so the place search and place buttons have something to choose between. It exists only in this local server.
- **Sample bookings:** three are added on start. One is paid online, one is pay on arrival waiting for you to confirm, and one is a price-on-request inquiry.
- **Everything resets** when you stop the server with Ctrl+C. Uploaded photos and videos and password changes are lost too.
- **Photos and videos** upload the same way as on Supabase, big files in 6 MB pieces. To see the error the Free plan gives for files over 50 MB, start it with `$env:LOCAL_MAX_FILE_MB=50; npm run local`.
- **Limits still apply.** Every booking from your computer comes from one address, so after 6 unconfirmed bookings the site says "Too many attempts". Confirm or cancel some in the dashboard, or restart the server.
- **The sample logins never reach the live site.** They exist only inside `tests/local/server.mjs`, and Cloudflare publishes only the `web/` folder.

---

## Setup (about 1 hour)

### 1. Create the database (Supabase)

1. At [supabase.com](https://supabase.com), click **New project**. Choose the Mumbai region (`ap-south-1`) and keep the database password safe. Use a **brand-new project** just for this website. Don't reuse the La Palm Farms project or the Dhyana Stays app's database; `setup.sql` expects an empty project.
2. Open **SQL Editor → New query**. Paste the whole of `supabase/setup.sql` and click **Run**. It should finish with "Success".
   - This creates the **Auroville** location and contact details taken from the app's footer: +91 98400 36900, support@dhyanastays.com, ECR Road, Auroville. You can change all of them in the admin later.
   - It also creates two sample rooms, which you'll replace.
3. Open **Project Settings → API** and copy:
   - the **Project URL**, like `https://abcdxyz.supabase.co`
   - the **anon** or **publishable** key. This one is safe to put on the website.
   - ⚠️ Never put the **service_role** or **secret** key in `config.js`.
4. Put both values in `web/config.js` → `supabase.url` and `supabase.key`.

### 2. Make yourself the admin

1. Go to **Authentication → Users → Add user → Create new user**. Enter the owner's email and a strong password (10+ characters), and tick **Auto confirm user**.
2. In **SQL Editor**, replace the email below and run:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'owner@dhyanastays.com';
   ```
3. Under **Authentication → Sign In / Providers → Email**, turn **off** "Allow new users to sign up".
4. Under **Authentication → URL Configuration**:
   - **Site URL:** `https://dhyanastays.com`
   - **Redirect URLs:** add `https://dhyanastays.com/admin`, `https://dhyanastays.com/admin.html`, `https://www.dhyanastays.com/admin` and `https://www.dhyanastays.com/admin.html`.
5. Password-reset emails: Supabase's built-in mailer only delivers to members of your Supabase team. Either invite the owner's email to the team, or set up SMTP (**Authentication → Emails → SMTP Settings**; Resend works well).

### 3. Razorpay

1. In the [Razorpay Dashboard](https://dashboard.razorpay.com), switch to **Test mode** and generate API keys. That gives you a **Key ID** (`rzp_test_…`) and a **Key Secret**.
2. Check that payments are captured automatically (Account & Settings → Payment capture). This is the default for new accounts.
3. Add a webhook (Account & Settings → **Webhooks → Add new webhook**):
   - URL: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/booking-api/webhook`
   - Secret: invent a long random string and keep it for step 4.
   - Events: tick `payment.captured` and `order.paid`.

### 4. Deploy the booking server (Supabase Edge Function)

**From the dashboard:** go to **Edge Functions → Deploy a new function → Via editor**. Name it exactly `booking-api`, paste the contents of `supabase/functions/booking-api/index.ts`, and deploy. Then open the function's settings and **turn off "Verify JWT"**. The function is public by design and checks its own input.

**Or with the command line:** from this folder, run `npx supabase functions deploy booking-api --no-verify-jwt --project-ref YOUR-PROJECT-REF`.

Then go to **Edge Functions → Secrets** and add:

| Secret | Value |
|---|---|
| `RAZORPAY_KEY_ID` | `rzp_test_…` from step 3 |
| `RAZORPAY_KEY_SECRET` | the Razorpay key secret |
| `RAZORPAY_WEBHOOK_SECRET` | the webhook secret you invented in step 3 |
| `ALLOWED_ORIGINS` | `https://dhyanastays.com,https://www.dhyanastays.com,https://YOUR-SITE.pages.dev` |
| `IP_HASH_SALT` | any long random string |
| `SITE_NAME` | `Dhyana Stays` |
| `SITE_URL` | `https://dhyanastays.com` |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are supplied automatically, so don't add them.

### 5. Photos and wording

- The site already uses the Dhyana Stays logo, colours (sage and antique gold), fonts and wording.
- **Photos:** the page photos are `web/images/hero.jpg` (top of the page), `about.jpg` (about section) and `banner.jpg` (the quote strip). To change one, save a new photo over it with the same name, roughly 1600 × 900 and under 400 KB ([squoosh.app](https://squoosh.app) shrinks them). If you use a different file name, update `hero.image`, `about.image` or `banner.image` in `config.js`; for the top photo, also update the `preload` line in `index.html`. Room photos and videos are uploaded in the admin (see below).
- **The current photos are computer-generated illustrations.** They're fine for setting the mood, but guests expect real photos of the place they're booking. Swap them for real photos of your stays as soon as you have them, and never use an illustration as a room photo.
- **Share image:** `images/og-image.jpg` is what WhatsApp and Facebook show when someone shares the link. It's 1200 × 630 and made from the top photo. When you change the top photo, make a new one the same size.
- **⚠️ Policies:** replace the sample cancellation policy, check-in/out times and house rules in `config.js` → `policies` with your real ones **before going live**. Guests see these before paying.

#### Room photos and videos

Each room has a **Photos & videos** section in **admin → Rooms**:

- **Add** photos (JPEG, PNG or WebP, up to 20 MB each) and videos (MP4, WebM or MOV). Everything for one stay can add up to **500 MB**; the meter shows how much is used.
- **Arrange** them with the ← → arrows. The first one is the **cover** on the website (**Make cover** moves one to the front). Guests tap the cover to open a gallery in the same order, with videos playable.
- New files upload when you click **Save changes**, with a progress bar. Big videos go up in 6 MB pieces and carry on by themselves if the connection drops for a moment. Keep the page open until it's done.
- **Remove** takes an item off the list; its file is deleted from storage when you save.

**Supabase plan limits.** The Free plan refuses any single file over **50 MB** and has **1 GB** of storage in total (about two stays at 500 MB each). For bigger videos or more stays, use the Pro plan and set **Storage → Settings → Global file size limit** to **500 MB**. Every video a guest watches also counts towards Supabase's bandwidth (egress) allowance, so keep videos short: a 1–2 minute 1080p MP4 is usually 30–100 MB. MP4 (H.264) plays in every browser; MOV from an iPhone may not play in Chrome on Windows.

### 6. Put the code on GitHub

1. On [github.com](https://github.com/new), create a **new, empty repository**, for example `dhyana-stays-website`. Make it **Private**: nothing secret is in these files, but there's no reason to publish them. Don't tick "Add a README"; the repository must start empty.
2. Save your `config.js` changes from step 1, then from this folder run (with your repository's address):
   ```powershell
   git add -A
   git commit -m "Add Supabase project details"
   git remote add origin https://github.com/YOUR-ACCOUNT/dhyana-stays-website.git
   git push -u origin main
   ```

### 7. Put it online on dhyanastays.com (Cloudflare Pages)

1. In [Cloudflare](https://dash.cloudflare.com), go to **Workers & Pages → Create → Pages → Connect to Git** (it may be labelled "Import an existing Git repository"). Allow Cloudflare to see the repository, then pick it.
2. Use these build settings:

   | Setting | Value |
   |---|---|
   | Production branch | `main` |
   | Framework preset | None |
   | Build command | *(leave empty)* |
   | Build output directory | `web` |
   | Root directory | *(leave empty)* |

3. Click **Save and Deploy**. You get an address like `dhyana-stays-website.pages.dev`. Put that exact address into `ALLOWED_ORIGINS` (step 4).
4. Under **Custom domains**, add `dhyanastays.com` and `www.dhyanastays.com`. Cloudflare shows the DNS records to add; if the domain is already on Cloudflare, it adds them for you. If `dhyanastays.com` currently points at another site, that site stops showing once DNS switches.
5. Set up a redirect so `www.dhyanastays.com` goes to `https://dhyanastays.com`: **Rules → Redirect Rules**, or a **Bulk Redirect**.

From then on, **every push to `main` goes live within a minute or two**. A push to any other branch gets its own preview address. Bookings are refused on those previews because they aren't in `ALLOWED_ORIGINS`, which keeps test copies from taking real bookings.

If you already made a Pages project by uploading files, create a new one for Git. Cloudflare can't switch an uploaded project to Git.

### 8. First login — fill in the details

Open `https://dhyanastays.com/admin.html` and log in. Then:

- **Settings → Contact details:** check the phone numbers, WhatsApp, emails, office address, Google Maps link and support hours. They appear on the website, invoices and guest emails.
- **Settings → Business & GST:** enter the legal business name. Switch GST on and enter the GSTIN only if you're registered.
- **Locations → Auroville:** add the full address, PIN code, map link and a short description. Add each other place you host stays with **+ Add location**.
- **Rooms:** replace the sample rooms. For each room, choose its **location** and set prices, how many of that room you have, the maximum guests, and its photos and videos (the first one is the cover).

Above the rooms, the website shows a place search, a button for each location, and price filters (a price range per night, and **Weekend price**: any, special weekend price, or the same price every day). With **Special weekend price** chosen, the price range is compared with the weekend rate; otherwise with each stay's lowest nightly rate. Price-on-request stays drop out while a price range is set, and the filters hide themselves if no stay has a price. Guests can type a town, area, state or PIN code, and the search also reads the location's address and description, so "Pondicherry" finds Auroville. Once rooms exist in two or more locations, an **All stays** button appears too, and the booking form groups rooms by location. When a guest clicks **Book this room**, the booking form opens on just that room, and they can switch with **Change**. If they've picked a place first, **Book now** offers only that place's rooms. Filling in each location's area, address and description makes the search work better.

---

## Test before going live

With Razorpay in **test mode**, run through each of these:

- [ ] Book a room and **pay online**. Use UPI ID `success@razorpay` or a test card from Razorpay's docs. You should see "Booking confirmed!" and a **DS/…** invoice number, and the invoice download should work.
- [ ] Make another online booking, and **close the tab** the moment payment succeeds. Within a minute the admin should show it as confirmed and paid. That's the webhook doing its job.
- [ ] Try UPI `failure@razorpay`. You should see an error, and nothing should be confirmed.
- [ ] Book **pay on arrival**. It should appear under **Needs action**. Confirm it, then **record the payment**, which issues the next invoice number.
- [ ] Fill a room's dates until it's **full**. Those dates should be struck out on the calendar.
- [ ] Change a phone number in **Settings**, reload the website, and check the new number shows.
- [ ] Add a second location with a room. Check that the place buttons show it, and that searching its town or area finds it.
- [ ] Use **+ Add booking** for a phone guest. Those dates should then be blocked online.
- [ ] Use **Forgot password** on the admin login, and check the reset email arrives and works.
- [ ] Open the site on a phone and check the layout.

## Going live

1. Get the Razorpay account activated (KYC), then generate **live** keys.
2. Change **only** the edge-function secrets `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. Nothing in the website files changes.
3. Create the webhook again in **live mode**, and update `RAZORPAY_WEBHOOK_SECRET` if you used a new secret.
4. Delete test bookings. Only unpaid ones can be deleted; cancel paid test bookings and mark them refunded.
5. **GST:**
   - The built-in slabs are: up to ₹1,000 a night exempt; up to ₹7,500 a night 5% (no input tax credit); above ₹7,500 a night 18%. These have been in force since 22 Sep 2025. Confirm them with your accountant.
   - **Auroville is in Tamil Nadu** (GST state code 33), not the Union Territory of Puducherry (34), even though it's often called "Auroville, Pondicherry". The Auroville location is set to Tamil Nadu, so check that matches your GST registration.
   - Stays in other states need that state's GSTIN, entered on the location. The admin warns you if it's missing.

---

## Day-to-day (for the owner)

- **Needs action:** pay-on-arrival requests wait here. **Confirm within 24 hours** (the default), or they're released automatically.
- **Guest pays at check-in:** open the booking → choose UPI/Cash/Card/Bank → **Record payment received**. This issues the invoice.
- **Cancellation:** open the booking → **Cancel**, which frees the dates. If it was paid, refund it in Razorpay, then click **Mark refunded**.
- **Phone or walk-in booking, or blocking dates:** **+ Add booking**.
- **Contact details changed:** **Settings → Contact details → Save**. The website, new invoices and emails update immediately.
- **New place to host stays:** **Locations → + Add location**, then add rooms to it in **Rooms**.
- **Pause a location:** untick "Show on website" on the location. Its rooms disappear from the site, but existing bookings stay.
- **"Needs attention" in red:** a guest paid after their hold expired and someone else took the dates. Call them, then rebook or refund.
- **Export CSV** downloads the bookings in the current filter, including location, for your accountant.
- **Changing the website's files** (wording, photos, policies): edit them, then `git add -A`, `git commit -m "what changed"` and `git push`. Cloudflare publishes the change automatically. Contact details, rooms, locations and prices don't need this; they're edited in the admin.
- **Changing the booking server** (`supabase/functions/booking-api/index.ts`): pushing to GitHub does **not** update it. Deploy it again as in step 4.

## Optional extras

**Confirmation emails (recommended).**
1. Create a [Resend](https://resend.com) account and verify the `dhyanastays.com` domain.
2. Add these edge-function secrets: `RESEND_API_KEY`, `EMAIL_FROM` = `Dhyana Stays <bookings@dhyanastays.com>`, and `OWNER_EMAIL`.
3. Set `emailConfirmations: true` in `config.js`.

Guest emails end with the contact details from admin → Settings.

**Bot protection.** Create a free [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) widget for `dhyanastays.com`. Put its *site key* in `config.js` → `turnstileSiteKey`, and its *secret key* in the edge-function secret `TURNSTILE_SECRET`.

## Troubleshooting

| You see | Fix |
|---|---|
| "That file is bigger than your Supabase plan accepts" when uploading a video | The Free plan takes files up to 50 MB. Make the video smaller, or move to Pro and raise **Storage → Settings → Global file size limit** to 500 MB. |
| A room's video shows a black box or won't play | Use MP4 (H.264). Some MOV files from phones only play in Safari. |
| "Our rooms couldn't be loaded" | `supabase.url` / `supabase.key` in `config.js` are wrong, or `setup.sql` wasn't run. The site then shows the fallback phone and email from `config.js` → `contactFallback`. |
| A room doesn't appear on the site | Check that the room *and* its location both have "Show on website" ticked. |
| "Online booking isn't fully set up yet" | An edge-function secret is missing. Check **Edge Functions → booking-api → Logs**. |
| "Bookings aren't accepted from this web address" | Add that exact address (with `https://`) to `ALLOWED_ORIGINS`. |
| Payment succeeds but the booking stays "Payment pending" | Check that the webhook URL and `RAZORPAY_WEBHOOK_SECRET` match, and that the webhook mode (test/live) matches your keys. |
| "This account isn't set up as an admin" | Run the `insert into public.admins …` query from step 2. |
| Reset email never arrives | See step 2.5. |
| A new script or font is blocked | Add its domain to the `Content-Security-Policy` line in `web/_headers`. |
| VS Code shows red errors in `setup.sql` | The editor is treating it as Microsoft SQL Server. It's PostgreSQL, so switch the language mode to PostgreSQL, or ignore the marks. |

## Automated tests (optional, for developers)

These need [Node.js](https://nodejs.org) 22+. They run `setup.sql` on a real Postgres (PGlite), the edge function, and both pages in a simulated browser, all locally.

```
cd tests
npm install
npm test        # 235 checks: database rules, booking server, website + admin
```
