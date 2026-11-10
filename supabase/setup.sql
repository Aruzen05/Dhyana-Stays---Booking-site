-- =====================================================================
--  DHYANA STAYS — DATABASE SETUP (stay booking template)
--  Paste this whole file into Supabase → SQL Editor → Run.
--  Made for a NEW, empty Supabase project. Safe to run again.
--
--  Security model (in one breath):
--   • The public website can only: read active rooms, read settings,
--     read per-night booked counts (no names), and ask for a price quote.
--   • Guests create bookings ONLY through the `booking-api` edge function,
--     which runs with the service key and calls create_booking().
--   • Only users listed in public.admins can see guests, edit rooms,
--     upload photos, change settings or change a booking's status.
--   • Overlapping bookings of the same room unit are impossible:
--     the database itself rejects them (exclusion constraint).
-- =====================================================================

create extension if not exists btree_gist with schema extensions;

-- Validators used by CHECK constraints (pure functions, safe for anyone to call).
create or replace function public.valid_phones(p text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(x ~ '^\+?[0-9 ()-]{7,20}$'), true) from unnest(p) as x
$$;
create or replace function public.valid_emails(p text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(length(x) <= 254 and x ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'), true) from unnest(p) as x
$$;
create or replace function public.valid_lines(p text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(length(x) between 1 and 120), true) from unnest(p) as x
$$;

-- ---------------------------------------------------------------------
--  TABLES
-- ---------------------------------------------------------------------

-- One row of business settings, editable from the admin "Settings" tab.
-- Contact details live here (not in config.js) so the owner can change them
-- from the admin portal; the website, invoices and emails all read them.
create table if not exists public.settings (
  id                   boolean primary key default true check (id),
  business_legal_name  text not null default 'Your Business Name' check (length(business_legal_name) between 1 and 120),
  contact_phones       text[] not null default '{}' check (cardinality(contact_phones) <= 5 and public.valid_phones(contact_phones)),
  contact_whatsapp     text check (contact_whatsapp is null or contact_whatsapp ~ '^\+?[0-9 ()-]{7,20}$'),
  contact_emails       text[] not null default '{}' check (cardinality(contact_emails) <= 5 and public.valid_emails(contact_emails)),
  contact_address      text[] not null default '{}' check (cardinality(contact_address) <= 6 and public.valid_lines(contact_address)),
  contact_map_url      text check (contact_map_url is null or contact_map_url ~ '^https://[^\s"''<>]+$'),
  contact_hours        text check (length(contact_hours) <= 120),
  gst_enabled          boolean not null default false,
  gstin                text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  invoice_prefix       text not null default 'INV' check (invoice_prefix ~ '^[A-Z0-9]{1,5}$'),
  timezone             text not null default 'Asia/Kolkata',
  weekend_nights       int[] not null default '{5,6}',      -- 0=Sun … 6=Sat. {5,6} = Friday & Saturday nights
  allow_pay_on_arrival boolean not null default true,
  arrival_hold_hours   int not null default 24 check (arrival_hold_hours between 1 and 168),
  online_hold_minutes  int not null default 30 check (online_hold_minutes between 20 and 180),
  max_nights           int not null default 30 check (max_nights between 1 and 365),
  booking_window_days  int not null default 365 check (booking_window_days between 7 and 730),
  updated_at           timestamptz not null default now(),
  check (not gst_enabled or gstin is not null)
);
-- Starting values (taken from the Dhyana Stays app footer) — change them in admin → Settings.
insert into public.settings (id, business_legal_name, invoice_prefix, contact_phones, contact_whatsapp, contact_emails,
                             contact_address, contact_hours)
values (true, 'Dhyana Stays', 'DS', array['+91 98400 36900'], '+91 98400 36900', array['support@dhyanastays.com'],
        array['ECR Road, Auroville', 'Near Pondicherry, Tamil Nadu'], 'Support every day, 24×7')
on conflict (id) do nothing;

-- Places where stays are offered. Each room belongs to one location.
-- `state` decides the GST place of supply; a location in another state
-- needs that state's GSTIN (set it on the location).
create table if not exists public.locations (
  id            text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name          text not null check (length(name) between 1 and 80),
  area_label    text check (length(area_label) <= 80),                 -- e.g. "Near Pondicherry"
  description   text check (length(description) <= 1000),
  address_lines text[] not null default '{}' check (cardinality(address_lines) <= 6 and public.valid_lines(address_lines)),
  city          text check (length(city) <= 80),
  state         text not null check (length(state) between 2 and 60),
  postal_code   text check (postal_code is null or postal_code ~ '^[0-9]{6}$'),
  map_url       text check (map_url is null or map_url ~ '^https://[^\s"''<>]+$'),
  latitude      numeric(9, 6) check (latitude between -90 and 90),
  longitude     numeric(9, 6) check (longitude between -180 and 180),
  gstin         text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  sort_order    int not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
insert into public.locations (id, name, area_label, description, address_lines, city, state, sort_order)
values ('auroville', 'Auroville', 'Near Pondicherry',
        'Our home base — calm, green and a short drive from Pondicherry.',
        array['ECR Road, Auroville'], 'Auroville', 'Tamil Nadu', 1)
on conflict (id) do nothing;

-- People allowed into admin.html. Add the owner after creating their login (see README).
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id              text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  location_id     text references public.locations(id) on update cascade,
  name            text not null check (length(name) between 1 and 80),
  capacity_label  text check (length(capacity_label) <= 80),         -- shown to guests, e.g. "2 Adults + 1 Child"
  max_guests      int  not null default 2 check (max_guests between 1 and 50),   -- per room unit, enforced
  description     text check (length(description) <= 2000),
  features        text[] not null default '{}' check (cardinality(features) <= 30),
  price_per_night int  check (price_per_night between 1 and 10000000),           -- whole rupees; NULL = price on request
  weekend_price   int  check (weekend_price between 1 and 10000000),
  max_units       int  not null default 1 check (max_units between 1 and 99),    -- how many identical rooms of this type
  image_url       text check (image_url is null or image_url ~ '^(https://|images/)'),
  sort_order      int  not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.bookings (
  id                  uuid primary key default gen_random_uuid(),
  ref                 text not null unique default ('BK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  room_id             text not null references public.rooms(id) on update cascade,
  room_name           text not null,                       -- snapshot at booking time
  location_id         text,                                -- snapshot (no FK: history survives a deleted location)
  location_name       text,
  num_units           int  not null check (num_units between 1 and 99),
  check_in            date not null,
  check_out           date not null,
  num_guests          int  not null check (num_guests between 1 and 500),
  guest_name          text not null check (length(guest_name) between 1 and 100),
  guest_email         text check (guest_email is null or (length(guest_email) <= 254 and guest_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  guest_phone         text check (guest_phone is null or guest_phone ~ '^\+?[0-9 ()-]{7,20}$'),
  special_requests    text check (length(special_requests) <= 1000),
  source              text not null check (source in ('online', 'arrival', 'inquiry', 'manual')),
  status              text not null check (status in ('hold', 'confirmed', 'completed', 'cancelled', 'expired', 'inquiry')),
  payment_status      text not null default 'unpaid' check (payment_status in ('unpaid', 'paid', 'refunded')),
  payment_method      text check (payment_method in ('razorpay', 'cash', 'upi', 'card', 'bank', 'other')),
  needs_attention     boolean not null default false,
  hold_expires_at     timestamptz,
  quote               jsonb,                               -- full price breakdown, frozen at booking time
  subtotal_paise      bigint not null default 0 check (subtotal_paise >= 0),
  gst_paise           bigint not null default 0 check (gst_paise >= 0),
  total_paise         bigint not null default 0 check (total_paise >= 0),
  razorpay_order_id   text unique,
  razorpay_payment_id text unique,
  paid_at             timestamptz,
  invoice_no          text unique,
  invoice_date        date,
  admin_notes         text check (length(admin_notes) <= 4000),
  client_ip_hash      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (check_out > check_in),
  check (status <> 'hold' or hold_expires_at is not null)
);
create index if not exists bookings_room_dates_idx on public.bookings (room_id, check_in, check_out);
create index if not exists bookings_created_idx    on public.bookings (created_at desc);
create index if not exists bookings_hold_idx       on public.bookings (hold_expires_at) where status = 'hold';
create index if not exists bookings_ip_idx         on public.bookings (client_ip_hash, created_at);
create index if not exists bookings_email_idx      on public.bookings (guest_email) where status = 'hold';

-- Which physical unit (1..max_units) each booking occupies.
-- The EXCLUDE constraint makes double-booking impossible at the database level.
create table if not exists public.booking_units (
  booking_id uuid not null references public.bookings(id) on delete cascade,
  room_id    text not null references public.rooms(id) on update cascade,
  unit_no    int  not null check (unit_no between 1 and 99),
  stay       daterange not null,
  active     boolean not null default true,
  primary key (booking_id, unit_no),
  constraint no_double_booking exclude using gist (room_id with =, unit_no with =, stay with &&) where (active)
);

-- Sequential invoice numbers per Indian financial year (April–March).
create table if not exists public.invoice_counters (
  fy      text primary key,
  last_no int  not null default 0
);

-- ---------------------------------------------------------------------
--  updated_at triggers
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before update on public.settings for each row execute function public.touch_updated_at();
drop trigger if exists locations_touch on public.locations;
create trigger locations_touch before update on public.locations for each row execute function public.touch_updated_at();
drop trigger if exists rooms_touch on public.rooms;
create trigger rooms_touch before update on public.rooms for each row execute function public.touch_updated_at();
drop trigger if exists bookings_touch on public.bookings;
create trigger bookings_touch before update on public.bookings for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
--  HELPERS (internal — not callable from the website)
-- ---------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

create or replace function public.local_today() returns date
language sql stable security definer set search_path = '' as $$
  select (now() at time zone (select timezone from public.settings where id))::date
$$;

-- Indian GST on hotel accommodation, decided per room unit per night
-- (rates in force since 22 Sep 2025 — confirm with your CA):
--   up to ₹1,000 → exempt · up to ₹7,500 → 5% (no ITC) · above ₹7,500 → 18%
create or replace function public.gst_rate_for(p_tariff int) returns int
language sql immutable set search_path = '' as $$
  select case when p_tariff <= 1000 then 0 when p_tariff <= 7500 then 5 else 18 end
$$;

create or replace function public.booking_json(b public.bookings) returns jsonb
language sql immutable set search_path = '' as $$
  select to_jsonb(b) - 'client_ip_hash'
$$;

create or replace function public.validate_stay(p_check_in date, p_check_out date, p_allow_past boolean)
returns void language plpgsql stable security definer set search_path = '' as $$
declare s public.settings; t date := public.local_today();
begin
  select * into s from public.settings where id;
  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in then raise exception 'invalid_dates'; end if;
  if not p_allow_past and p_check_in < t then raise exception 'date_in_past'; end if;
  if p_check_out - p_check_in > s.max_nights then raise exception 'too_many_nights'; end if;
  if p_check_in > t + s.booking_window_days then raise exception 'too_far_ahead'; end if;
end $$;

-- Price breakdown for a stay. Amounts in paise. Room may be inactive (admin use).
create or replace function public.compute_quote(p_room_id text, p_check_in date, p_check_out date, p_units int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r public.rooms; s public.settings; l public.locations; loc jsonb;
  d date; tariff int; rate int; is_we boolean;
  nightly jsonb := '[]'::jsonb; sub bigint := 0; gst bigint := 0; n int := 0;
begin
  select * into s from public.settings where id;
  select * into r from public.rooms where id = p_room_id;
  if not found then raise exception 'room_not_found'; end if;
  if r.location_id is not null then
    select * into l from public.locations where id = r.location_id;
    loc := jsonb_build_object('id', l.id, 'name', l.name, 'area_label', l.area_label, 'address_lines', to_jsonb(l.address_lines),
                              'city', l.city, 'state', l.state, 'postal_code', l.postal_code);
  end if;

  if r.price_per_night is null then
    return jsonb_build_object('priced', false, 'room_id', r.id, 'room_name', r.name, 'location', loc,
      'check_in', p_check_in, 'check_out', p_check_out, 'nights', p_check_out - p_check_in, 'units', p_units,
      'subtotal_paise', 0, 'gst_paise', 0, 'total_paise', 0);
  end if;

  d := p_check_in;
  while d < p_check_out loop
    is_we := extract(dow from d)::int = any (s.weekend_nights);
    tariff := case when is_we and r.weekend_price is not null then r.weekend_price else r.price_per_night end;
    rate := case when s.gst_enabled then public.gst_rate_for(tariff) else 0 end;
    sub := sub + tariff::bigint * 100 * p_units;
    gst := gst + tariff::bigint * rate * p_units;          -- (tariff × 100 paise) × rate / 100
    nightly := nightly || jsonb_build_object('date', d, 'tariff', tariff, 'gst_rate', rate, 'weekend', is_we);
    d := d + 1; n := n + 1;
  end loop;

  return jsonb_build_object(
    'priced', true, 'room_id', r.id, 'room_name', r.name, 'location', loc,
    'check_in', p_check_in, 'check_out', p_check_out, 'nights', n, 'units', p_units,
    'nightly', nightly, 'subtotal_paise', sub, 'gst_paise', gst, 'total_paise', sub + gst,
    'gst_enabled', s.gst_enabled, 'gstin', coalesce(l.gstin, s.gstin), 'legal_name', s.business_legal_name);
end $$;

-- A room can be booked by guests only if it and its location are both switched on.
create or replace function public.room_bookable(p_room_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.rooms r left join public.locations l on l.id = r.location_id
     where r.id = p_room_id and r.is_active and (r.location_id is null or l.is_active))
$$;

-- Marks holds whose timer ran out as expired and frees their room units.
create or replace function public.expire_stale_holds() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  with exp as (
    update public.bookings set status = 'expired'
     where status = 'hold' and hold_expires_at <= now()
     returning id
  ), freed as (
    update public.booking_units set active = false where booking_id in (select id from exp) returning 1
  )
  select count(*) into n from exp;
  return n;
end $$;

create or replace function public.next_invoice_no() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_day date := public.local_today(); v_year int; v_fy text; v_no int; v_prefix text;
begin
  v_year := extract(year from v_day)::int;
  if extract(month from v_day) < 4 then v_year := v_year - 1; end if;
  v_fy := lpad((v_year % 100)::text, 2, '0') || '-' || lpad(((v_year + 1) % 100)::text, 2, '0');   -- e.g. 26-27
  insert into public.invoice_counters as c (fy, last_no) values (v_fy, 1)
    on conflict (fy) do update set last_no = c.last_no + 1
    returning c.last_no into v_no;
  select invoice_prefix into v_prefix from public.settings where id;
  return v_prefix || '/' || v_fy || '/' || lpad(v_no::text, 4, '0');                             -- e.g. INV/26-27/0001
end $$;

-- ---------------------------------------------------------------------
--  PUBLIC (website) FUNCTIONS
-- ---------------------------------------------------------------------

-- Booked unit count per night for one room type. Contains no guest data.
create or replace function public.get_availability(p_room_id text, p_from date, p_to date)
returns table (night date, booked int)
language sql stable security definer set search_path = '' as $$
  select g.night, count(x.booking_id)::int
  from (
    select generate_series(p_from::timestamp, (least(p_to, p_from + 400) - 1)::timestamp, interval '1 day')::date as night
  ) g
  left join (
    select u.booking_id, u.stay
      from public.booking_units u
      join public.bookings b on b.id = u.booking_id
     where u.room_id = p_room_id and u.active
       and (b.status <> 'hold' or b.hold_expires_at > now())
  ) x on x.stay @> g.night
  group by g.night
  order by g.night
$$;

-- Authoritative price for a stay (the website shows exactly what will be charged).
create or replace function public.quote_stay(p_room_id text, p_check_in date, p_check_out date, p_units int default 1)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.rooms;
begin
  if not public.room_bookable(p_room_id) then raise exception 'room_not_found'; end if;
  select * into r from public.rooms where id = p_room_id;
  if p_units is null or p_units < 1 or p_units > r.max_units then raise exception 'invalid_units'; end if;
  perform public.validate_stay(p_check_in, p_check_out, false);
  return public.compute_quote(p_room_id, p_check_in, p_check_out, p_units);
end $$;

-- ---------------------------------------------------------------------
--  SERVER-ONLY FUNCTIONS (called by the booking-api edge function)
-- ---------------------------------------------------------------------
create or replace function public.create_booking(
  p_room_id text, p_check_in date, p_check_out date, p_units int, p_guests int,
  p_name text, p_email text, p_phone text, p_requests text, p_mode text,
  p_ip_hash text default null, p_admin boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.settings; r public.rooms; b public.bookings; q jsonb; v_loc_name text;
  v_source text; v_status text; v_exp timestamptz; v_stay daterange; v_free int[] := '{}'; u int;
  v_phone_digits text;
begin
  select * into s from public.settings where id;
  if not (p_admin or public.room_bookable(p_room_id)) then raise exception 'room_not_found'; end if;
  select * into r from public.rooms where id = p_room_id;
  if not found then raise exception 'room_not_found'; end if;
  select name into v_loc_name from public.locations where id = r.location_id;

  perform public.validate_stay(p_check_in, p_check_out, p_admin);
  if p_units is null or p_units < 1 or p_units > r.max_units then raise exception 'invalid_units'; end if;
  if p_guests is null or p_guests < 1 or p_guests > r.max_guests * p_units then raise exception 'too_many_guests'; end if;

  p_name     := nullif(btrim(p_name), '');
  p_email    := nullif(lower(btrim(p_email)), '');
  p_phone    := nullif(btrim(p_phone), '');
  p_requests := nullif(btrim(p_requests), '');
  if p_name is null then raise exception 'name_required'; end if;
  if not p_admin and (p_email is null or p_phone is null) then raise exception 'contact_required'; end if;
  v_phone_digits := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');

  if p_admin then v_source := 'manual';
  elsif r.price_per_night is null then v_source := 'inquiry';
  elsif p_mode = 'online' then v_source := 'online';
  elsif p_mode = 'arrival' then
    if not s.allow_pay_on_arrival then raise exception 'arrival_disabled'; end if;
    v_source := 'arrival';
  else raise exception 'invalid_mode';
  end if;

  if not p_admin then
    -- A guest retrying online payment replaces their own earlier unpaid online hold.
    with sup as (
      update public.bookings set status = 'expired'
       where status = 'hold' and source = 'online' and payment_status = 'unpaid'
         and guest_email = p_email
       returning id
    ) update public.booking_units set active = false where booking_id in (select id from sup);

    -- Anti-abuse. Strict per guest (email/phone); looser per network address, because
    -- many mobile users in India share one public IP (carrier-grade NAT).
    if (select count(*) from public.bookings
         where status = 'hold' and hold_expires_at > now()
           and (guest_email = p_email
                or (v_phone_digits <> '' and regexp_replace(coalesce(guest_phone, ''), '[^0-9]', '', 'g') = v_phone_digits))) >= 3 then
      raise exception 'too_many_holds';
    end if;
    if p_ip_hash is not null then
      if (select count(*) from public.bookings
           where status = 'hold' and hold_expires_at > now() and client_ip_hash = p_ip_hash) >= 6 then
        raise exception 'too_many_holds';
      end if;
      if (select count(*) from public.bookings
           where client_ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 12 then
        raise exception 'rate_limited';
      end if;
    end if;
  end if;

  if v_source = 'inquiry' then
    -- Price-on-request: recorded for the owner, does not block any dates.
    insert into public.bookings (room_id, room_name, location_id, location_name, num_units, check_in, check_out, num_guests,
        guest_name, guest_email, guest_phone, special_requests, source, status, quote, client_ip_hash)
      values (r.id, r.name, r.location_id, v_loc_name, p_units, p_check_in, p_check_out, p_guests,
        p_name, p_email, p_phone, p_requests, 'inquiry', 'inquiry',
        public.compute_quote(r.id, p_check_in, p_check_out, p_units), p_ip_hash)
      returning * into b;
    return public.booking_json(b);
  end if;

  -- Serialise bookings for this room type, then free any expired holds.
  perform pg_advisory_xact_lock(hashtext('room:' || r.id));
  perform public.expire_stale_holds();

  v_stay := daterange(p_check_in, p_check_out, '[)');
  for u in 1 .. r.max_units loop
    exit when cardinality(v_free) >= p_units;
    if not exists (select 1 from public.booking_units bu
                    where bu.room_id = r.id and bu.unit_no = u and bu.active and bu.stay && v_stay) then
      v_free := v_free || u;
    end if;
  end loop;
  if cardinality(v_free) < p_units then raise exception 'not_available'; end if;

  q := public.compute_quote(r.id, p_check_in, p_check_out, p_units);
  v_status := case when v_source = 'manual' then 'confirmed' else 'hold' end;
  v_exp := case v_source
             when 'online'  then now() + make_interval(mins => s.online_hold_minutes)
             when 'arrival' then now() + make_interval(hours => s.arrival_hold_hours)
           end;

  insert into public.bookings (room_id, room_name, location_id, location_name, num_units, check_in, check_out, num_guests,
      guest_name, guest_email, guest_phone, special_requests, source, status, hold_expires_at,
      quote, subtotal_paise, gst_paise, total_paise, client_ip_hash)
    values (r.id, r.name, r.location_id, v_loc_name, p_units, p_check_in, p_check_out, p_guests,
      p_name, p_email, p_phone, p_requests, v_source, v_status, v_exp,
      q, (q->>'subtotal_paise')::bigint, (q->>'gst_paise')::bigint, (q->>'total_paise')::bigint, p_ip_hash)
    returning * into b;

  insert into public.booking_units (booking_id, room_id, unit_no, stay)
    select b.id, r.id, x, v_stay from unnest(v_free) as x;

  return public.booking_json(b);
end $$;

create or replace function public.set_razorpay_order(p_booking_id uuid, p_order_id text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.bookings set razorpay_order_id = p_order_id
   where id = p_booking_id and source = 'online' and status = 'hold' and razorpay_order_id is null;
  if not found then raise exception 'booking_not_found'; end if;
end $$;

-- Frees an online hold immediately (e.g. the payment order could not be created).
create or replace function public.release_hold(p_booking_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.bookings set status = 'expired'
   where id = p_booking_id and status = 'hold' and payment_status = 'unpaid';
  update public.booking_units set active = false where booking_id = p_booking_id;
end $$;

-- Called after Razorpay proves a payment (browser verify OR webhook). Idempotent.
create or replace function public.confirm_payment(p_order_id text, p_payment_id text, p_amount_paise bigint default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.bookings; ok boolean := true; mismatch boolean;
begin
  select * into b from public.bookings where razorpay_order_id = p_order_id for update;
  if not found then raise exception 'booking_not_found'; end if;
  if b.payment_status <> 'unpaid' then
    return public.booking_json(b) || jsonb_build_object('newly_paid', false);
  end if;

  mismatch := p_amount_paise is not null and p_amount_paise <> b.total_paise;
  perform pg_advisory_xact_lock(hashtext('room:' || b.room_id));

  if b.status in ('expired', 'cancelled') then
    -- Paid after the hold lapsed: take the dates back if nobody else has them.
    begin
      update public.booking_units set active = true where booking_id = b.id;
    exception when exclusion_violation then ok := false;
    end;
  end if;

  if ok then
    update public.bookings
       set status = 'confirmed', payment_status = 'paid', payment_method = 'razorpay',
           razorpay_payment_id = p_payment_id, paid_at = now(), hold_expires_at = null,
           invoice_no = public.next_invoice_no(), invoice_date = public.local_today(),
           needs_attention = mismatch,
           admin_notes = case when mismatch then concat_ws(E'\n', admin_notes,
             'Paid amount (' || p_amount_paise || ' paise) differs from the quoted total — check in Razorpay.') else admin_notes end
     where id = b.id returning * into b;
  else
    update public.bookings
       set payment_status = 'paid', payment_method = 'razorpay', razorpay_payment_id = p_payment_id,
           paid_at = now(), needs_attention = true,
           admin_notes = concat_ws(E'\n', admin_notes,
             'Paid after the hold expired and the dates were taken by another booking — refund or rebook this guest.')
     where id = b.id returning * into b;
  end if;
  return public.booking_json(b) || jsonb_build_object('newly_paid', true);
end $$;

-- ---------------------------------------------------------------------
--  ADMIN FUNCTIONS (signed-in admins only — each checks is_admin())
-- ---------------------------------------------------------------------
create or replace function public.admin_expire_holds() returns int
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not_authorised'; end if;
  return public.expire_stale_holds();
end $$;

create or replace function public.admin_set_status(p_id uuid, p_status text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare b public.bookings;
begin
  if not public.is_admin() then raise exception 'not_authorised'; end if;
  if p_status not in ('confirmed', 'completed', 'cancelled') then raise exception 'invalid_status'; end if;
  select * into b from public.bookings where id = p_id for update;
  if not found then raise exception 'booking_not_found'; end if;
  perform pg_advisory_xact_lock(hashtext('room:' || b.room_id));

  if p_status = 'cancelled' then
    update public.booking_units set active = false where booking_id = b.id;
    update public.bookings set status = 'cancelled', needs_attention = false where id = b.id returning * into b;

  elsif p_status = 'confirmed' then
    if b.source = 'inquiry' then raise exception 'inquiry_has_no_dates'; end if;
    perform public.expire_stale_holds();
    begin
      update public.booking_units set active = true where booking_id = b.id;
    exception when exclusion_violation then raise exception 'dates_taken';
    end;
    update public.bookings set status = 'confirmed', hold_expires_at = null, needs_attention = false,
           invoice_no   = case when payment_status = 'paid' and invoice_no is null then public.next_invoice_no()  else invoice_no end,
           invoice_date = case when payment_status = 'paid' and invoice_no is null then public.local_today() else invoice_date end
     where id = b.id returning * into b;

  else -- completed
    if b.status not in ('confirmed', 'inquiry') then raise exception 'invalid_transition'; end if;
    update public.bookings set status = 'completed' where id = b.id returning * into b;
  end if;
  return public.booking_json(b);
end $$;

-- Record a payment taken at the property (cash/UPI/card/bank) — issues the invoice number.
create or replace function public.admin_record_payment(p_id uuid, p_method text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare b public.bookings;
begin
  if not public.is_admin() then raise exception 'not_authorised'; end if;
  if p_method not in ('cash', 'upi', 'card', 'bank', 'other') then raise exception 'invalid_method'; end if;
  select * into b from public.bookings where id = p_id for update;
  if not found then raise exception 'booking_not_found'; end if;
  if b.payment_status <> 'unpaid' then raise exception 'already_paid'; end if;
  if b.status not in ('confirmed', 'completed') then raise exception 'confirm_first'; end if;
  if b.total_paise <= 0 then raise exception 'no_price'; end if;
  update public.bookings
     set payment_status = 'paid', payment_method = p_method, paid_at = now(),
         invoice_no = public.next_invoice_no(), invoice_date = public.local_today()
   where id = b.id returning * into b;
  return public.booking_json(b);
end $$;

create or replace function public.admin_mark_refunded(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare b public.bookings;
begin
  if not public.is_admin() then raise exception 'not_authorised'; end if;
  update public.bookings set payment_status = 'refunded', needs_attention = false
   where id = p_id and payment_status = 'paid' returning * into b;
  if not found then raise exception 'not_paid'; end if;
  return public.booking_json(b);
end $$;

-- Phone / walk-in bookings and owner blocks. Confirmed immediately; blocks the dates.
create or replace function public.admin_create_booking(
  p_room_id text, p_check_in date, p_check_out date, p_units int, p_guests int,
  p_name text, p_email text default null, p_phone text default null, p_requests text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not_authorised'; end if;
  return public.create_booking(p_room_id, p_check_in, p_check_out, p_units, p_guests,
                               p_name, p_email, p_phone, p_requests, 'manual', null, true);
end $$;

-- Deleting is only allowed for bookings that never got an invoice (tax records must be kept).
create or replace function public.admin_delete_booking(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not_authorised'; end if;
  if exists (select 1 from public.bookings where id = p_id and (invoice_no is not null or payment_status <> 'unpaid')) then
    raise exception 'has_payment_records';
  end if;
  delete from public.bookings where id = p_id;
end $$;

-- ---------------------------------------------------------------------
--  ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.settings         enable row level security;
alter table public.locations        enable row level security;
alter table public.admins           enable row level security;
alter table public.rooms            enable row level security;
alter table public.bookings         enable row level security;
alter table public.booking_units    enable row level security;
alter table public.invoice_counters enable row level security;

drop policy if exists "settings: anyone can read"  on public.settings;
drop policy if exists "settings: admins update"    on public.settings;
create policy "settings: anyone can read" on public.settings for select to anon, authenticated using (true);
create policy "settings: admins update"   on public.settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "locations: read active"   on public.locations;
drop policy if exists "locations: admins insert" on public.locations;
drop policy if exists "locations: admins update" on public.locations;
drop policy if exists "locations: admins delete" on public.locations;
create policy "locations: read active"   on public.locations for select to anon, authenticated using (is_active or (select public.is_admin()));
create policy "locations: admins insert" on public.locations for insert to authenticated with check ((select public.is_admin()));
create policy "locations: admins update" on public.locations for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "locations: admins delete" on public.locations for delete to authenticated using ((select public.is_admin()));

drop policy if exists "admins: see own row" on public.admins;
create policy "admins: see own row" on public.admins for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "rooms: read active"    on public.rooms;
drop policy if exists "rooms: admins insert"  on public.rooms;
drop policy if exists "rooms: admins update"  on public.rooms;
drop policy if exists "rooms: admins delete"  on public.rooms;
create policy "rooms: read active"   on public.rooms for select to anon, authenticated using (is_active or (select public.is_admin()));
create policy "rooms: admins insert" on public.rooms for insert to authenticated with check ((select public.is_admin()));
create policy "rooms: admins update" on public.rooms for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "rooms: admins delete" on public.rooms for delete to authenticated using ((select public.is_admin()));

drop policy if exists "bookings: admins read"         on public.bookings;
drop policy if exists "bookings: admins update notes" on public.bookings;
create policy "bookings: admins read"         on public.bookings for select to authenticated using ((select public.is_admin()));
create policy "bookings: admins update notes" on public.bookings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "booking_units: admins read" on public.booking_units;
create policy "booking_units: admins read" on public.booking_units for select to authenticated using ((select public.is_admin()));
-- invoice_counters: no policies → no API access at all.

-- Table privileges (defence in depth on top of RLS)
revoke all on public.bookings, public.booking_units, public.invoice_counters, public.admins from anon;
revoke insert, update, delete, truncate on public.bookings, public.booking_units, public.invoice_counters, public.admins from authenticated;
revoke insert, update, delete, truncate on public.rooms, public.settings, public.locations from anon;
revoke insert, delete, truncate on public.settings from authenticated;
grant  update (admin_notes) on public.bookings to authenticated;     -- the ONLY column admins edit directly

-- Function privileges: lock everything, then open exactly what each caller needs.
revoke execute on function
  public.touch_updated_at(), public.is_admin(), public.local_today(), public.gst_rate_for(int),
  public.booking_json(public.bookings), public.validate_stay(date, date, boolean),
  public.compute_quote(text, date, date, int), public.room_bookable(text), public.expire_stale_holds(), public.next_invoice_no(),
  public.get_availability(text, date, date), public.quote_stay(text, date, date, int),
  public.create_booking(text, date, date, int, int, text, text, text, text, text, text, boolean),
  public.set_razorpay_order(uuid, text), public.release_hold(uuid), public.confirm_payment(text, text, bigint),
  public.admin_expire_holds(), public.admin_set_status(uuid, text), public.admin_record_payment(uuid, text),
  public.admin_mark_refunded(uuid),
  public.admin_create_booking(text, date, date, int, int, text, text, text, text),
  public.admin_delete_booking(uuid)
from public, anon, authenticated;

grant execute on function public.is_admin() to anon, authenticated;                       -- used inside RLS policies
grant execute on function public.get_availability(text, date, date), public.quote_stay(text, date, date, int) to anon, authenticated;
grant execute on function
  public.admin_expire_holds(), public.admin_set_status(uuid, text), public.admin_record_payment(uuid, text),
  public.admin_mark_refunded(uuid), public.admin_create_booking(text, date, date, int, int, text, text, text, text),
  public.admin_delete_booking(uuid)
to authenticated;
grant execute on function
  public.create_booking(text, date, date, int, int, text, text, text, text, text, text, boolean),
  public.set_razorpay_order(uuid, text), public.release_hold(uuid), public.confirm_payment(text, text, bigint)
to service_role;

-- ---------------------------------------------------------------------
--  STORAGE: room photos (public to view, admins to upload)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('room-images', 'room-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "room-images: admins read"   on storage.objects;
drop policy if exists "room-images: admins upload" on storage.objects;
drop policy if exists "room-images: admins update" on storage.objects;
drop policy if exists "room-images: admins delete" on storage.objects;
create policy "room-images: admins read"   on storage.objects for select to authenticated
  using (bucket_id = 'room-images' and (select public.is_admin()));
create policy "room-images: admins upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'room-images' and (select public.is_admin()));
create policy "room-images: admins update" on storage.objects for update to authenticated
  using (bucket_id = 'room-images' and (select public.is_admin()));
create policy "room-images: admins delete" on storage.objects for delete to authenticated
  using (bucket_id = 'room-images' and (select public.is_admin()));

-- ---------------------------------------------------------------------
--  SAMPLE ROOMS (edit or replace them in the admin "Rooms" tab)
-- ---------------------------------------------------------------------
insert into public.rooms (id, location_id, name, capacity_label, max_guests, description, features, price_per_night, weekend_price, max_units, image_url, sort_order)
values
  ('garden-room', 'auroville', 'Garden Room', '2 Adults + 1 Child', 3,
   'A bright room opening onto the garden.', array['King-size bed', 'Attached bathroom', 'Garden view', 'AC & fan'],
   3000, 3500, 2, 'images/placeholder-room.svg', 1),
  ('cottage', 'auroville', 'Cottage', '2 Adults', 2,
   'A quiet stand-alone cottage with a private sit-out.', array['Queen bed', 'Private sit-out', 'Outdoor shower'],
   null, null, 1, 'images/placeholder-room.svg', 2)
on conflict (id) do nothing;
