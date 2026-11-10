/* =====================================================================
   DHYANA STAYS — SITE SETTINGS (brand text, colours, images)

   Managed in admin.html instead of here, so changes go live immediately:
     • Contact details (phones, WhatsApp, emails, address, map) → Settings
     • Locations (Auroville and any others)                     → Locations
     • Rooms, prices, photos                                     → Rooms
     • GST, invoices, pay-on-arrival, hold times                 → Settings

   Also edit the lines marked "BRAND" at the top of index.html when the
   wording changes, and replace the photos in images/.
   ===================================================================== */
window.SITE_CONFIG = {

  // From Supabase → Project Settings → API. The "anon" / "publishable" key is
  // meant to be public; the database rules (setup.sql) decide what it can do.
  // NEVER put the service_role / secret key here.
  supabase: {
    url: "https://YOUR-PROJECT-REF.supabase.co",
    key: "YOUR-ANON-OR-PUBLISHABLE-KEY",
  },

  brand: {
    name: "Dhyana Stays",
    tagline: "Curated wellness stays in Auroville, Pondicherry and beyond",
    siteUrl: "https://dhyanastays.com",
    logo: "images/logo.svg",
    fileSlug: "DhyanaStays",               // used in downloaded file names
  },

  // Dhyana Stays palette (sage + antique gold, from the Dhyana Stays app).
  theme: {
    primary: "#5C6544",      // deep sage — buttons, links (white text passes contrast)
    primaryDark: "#464E33",
    accent: "#D1AE76",       // antique gold, for use on dark backgrounds
    ink: "#2F3522",
    inkSoft: "#464E33",
    muted: "#6B7280",
    paper: "#FBFBF8",
    cream: "#F3F4EF",
    sand: "#DDE2CE",
    dark: "#2F3522",
    fontHeading: "Playfair Display",
    fontBody: "Inter",
  },

  hero: {
    eyebrow: "Auroville · Pondicherry · and beyond",
    title: "Dhyana",
    titleAccent: "Stays",
    text: "Handpicked retreats, spiritual sanctuaries and nature escapes — rooted in Auroville, with stays in other quiet corners we love.",
    image: "images/hero.jpg",               // if you change this, also change the "preload" line in index.html
    imageAlt: "A tiled-roof courtyard house with a lily pond in golden evening light",
  },

  highlights: [
    { icon: "🧘", label: "Space to slow down" },
    { icon: "🌿", label: "Nature all around" },
    { icon: "🏡", label: "Handpicked stays" },
    { icon: "🕊️", label: "Support every day, 24×7" },
  ],

  about: {
    eyebrow: "About Dhyana Stays",
    title: "Stays for a quieter mind",
    body: "Dhyana means meditation. We choose every stay for calm, nature and a slower rhythm — starting from our home in Auroville, near Pondicherry, and growing to other places worth pausing in.",
    image: "images/about.jpg",
    imageAlt: "A garden villa draped in green vines among tall trees",
  },

  banner: {
    quote: "“Arrive. Breathe. Stay a while.”",
    image: "images/banner.jpg",
    imageAlt: "A courtyard house with a pond at sunset, seen from above",
  },

  // Shown on the site and before guests pay. ⚠ Replace with your real policy.
  policies: {
    checkIn: "2:00 PM",
    checkOut: "11:00 AM",
    cancellation: "Free cancellation up to 7 days before check-in. 50% refund up to 48 hours before. No refund after that.",
    rules: [
      "Valid photo ID required for all adult guests at check-in.",
      "Quiet hours from 10 PM to 7 AM.",
      "No smoking indoors.",
    ],
  },

  // Used ONLY if the database can't be reached (normally contact details come
  // from admin → Settings). Keep one phone and one email here as a safety net.
  contactFallback: {
    phone: "+91 98400 36900",
    email: "support@dhyanastays.com",
  },

  timezone: "Asia/Kolkata",                 // must match admin → Settings → Time zone

  // true only after you've set up emails (RESEND_* secrets, see README) —
  // otherwise the site won't promise guests an email.
  emailConfirmations: false,

  // Optional bot protection (Cloudflare Turnstile). Leave "" to switch off.
  turnstileSiteKey: "",

  footerNote: "",
};
