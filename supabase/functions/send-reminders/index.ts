// Runs every minute (pg_cron). Works out which reminders are due in each person's own time zone
// and sends them as web push notifications. Also sends the 8am "today" summary.
// POST with a signed-in user's token and {"test": true} sends that user a test notification.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const APP_URL = "https://jamieh06.github.io/planner/";
const SUMMARY_MIN = 8 * 60;   // 08:00 local
const WINDOW = 10;            // minutes of grace if a run is late; the sent-log stops repeats

type Sub = { endpoint: string; user_id: string; p256dh: string; auth: string; tz: string };
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
const hm = (h: number) => h >= 24 ? "00:00" : `${pad(Math.floor(h))}:${pad(Math.round((h % 1) * 60))}`;
const dayNum = (ds: string) => Date.UTC(+ds.slice(0, 4), +ds.slice(5, 7) - 1, +ds.slice(8, 10)) / 864e5;
const dateOf = (n: number) => new Date(n * 864e5).toISOString().slice(0, 10);

function localNow(tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, day: dayNum(date), min: +p.hour * 60 + +p.minute };
}

// Day numbers on which an event happens between from and to (inclusive)
function occurrences(ev: any, from: number, to: number): number[] {
  const start = dayNum(ev.date), out: number[] = [];
  if (ev.repeat === "weekly") {
    const until = ev.until ? dayNum(ev.until) : Infinity, skip = new Set(ev.skip || []);
    for (let d = start + Math.max(0, Math.ceil((from - start) / 7)) * 7; d <= to && d <= until; d += 7) if (!skip.has(dateOf(d))) out.push(d);
  } else if (start >= from && start <= to) out.push(start);
  return out;
}

function leadText(m: number, ev: any, day: number) {
  if (m === 0) return "Starting now";
  if (m < 60) return `In ${m} min`;
  if (m < 1440) return `In ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${DOW[new Date(day * 864e5).getUTCDay()]} at ${hm(ev.s)}`;
}

async function claim(key: string) {
  const { error } = await db.from("notif_sent").insert({ key });
  return !error; // a duplicate key means another run already sent it
}

async function send(subs: Sub[], payload: object) {
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600 });
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("push_subs").delete().eq("endpoint", s.endpoint);
      else console.error("push failed", e?.statusCode, e?.body);
    }
  }
}

Deno.serve(async (req) => {
  const { data: secrets } = await db.from("app_secrets").select("name,value");
  const sec = Object.fromEntries((secrets || []).map((r: any) => [r.name, r.value]));
  webpush.setVapidDetails(APP_URL, sec.vapid_public, sec.vapid_private);
  const body = await req.json().catch(() => ({}));

  // Test notification for the signed-in user
  if (body.test) {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data } = await db.auth.getUser(token);
    if (!data?.user) return new Response("Not signed in", { status: 401 });
    const { data: subs } = await db.from("push_subs").select("*").eq("user_id", data.user.id);
    await send(subs || [], { title: "Planner", body: "Notifications are working.", tag: "test" });
    return Response.json({ sent: (subs || []).length });
  }

  if (req.headers.get("x-cron-secret") !== sec.cron_secret) return new Response("Forbidden", { status: 403 });

  const [{ data: rows }, { data: allSubs }] = await Promise.all([
    db.from("planner").select("user_id, doc"),
    db.from("push_subs").select("*"),
  ]);
  let sent = 0;
  for (const row of rows || []) {
    const subs = (allSubs || []).filter((s: Sub) => s.user_id === row.user_id);
    if (!subs.length) continue;
    const now = localNow(subs[0].tz || "Europe/London");
    const nowAbs = now.day * 1440 + now.min;
    const due = (fireAbs: number) => fireAbs <= nowAbs && fireAbs > nowAbs - WINDOW;
    const events = row.doc?.events || [], tasks = row.doc?.tasks || [];

    // Event reminders: look ahead far enough to cover "a week before" style reminders
    for (const ev of events) {
      const reminds: number[] = Array.isArray(ev.remind) ? ev.remind : [];
      if (!reminds.length) continue;
      for (const d of occurrences(ev, now.day - 1, now.day + 8)) {
        for (const m of reminds) {
          if (!due(d * 1440 + Math.round(ev.s * 60) - m)) continue;
          if (!(await claim(`ev:${ev.id}:${dateOf(d)}:${m}`))) continue;
          await send(subs, { title: ev.title, body: `${leadText(m, ev, d)} · ${hm(ev.s)}–${hm(ev.e)}${ev.where ? ` · ${ev.where}` : ""}`, tag: `ev-${ev.id}-${dateOf(d)}` });
          sent++;
        }
      }
    }

    // Task reminders at the exact local times given
    for (const t of tasks) {
      if (t.done || !Array.isArray(t.remind)) continue;
      for (const at of t.remind) {
        const fire = dayNum(at.slice(0, 10)) * 1440 + +at.slice(11, 13) * 60 + +at.slice(14, 16);
        if (!due(fire) || !(await claim(`task:${t.id}:${at}`))) continue;
        await send(subs, { title: t.title, body: t.due ? `Due ${t.due === now.date ? "today" : t.due}` : "Reminder", tag: `task-${t.id}` });
        sent++;
      }
    }

    // 8am summary of the day; skipped on empty days
    if (due(now.day * 1440 + SUMMARY_MIN)) {
      const today = events.flatMap((ev: any) => occurrences(ev, now.day, now.day).length ? [ev] : []).sort((a: any, b: any) => a.s - b.s);
      const dueToday = tasks.filter((t: any) => !t.done && t.due === now.date);
      const overdue = tasks.filter((t: any) => !t.done && t.due && t.due < now.date).length;
      if ((today.length || dueToday.length || overdue) && await claim(`daily:${row.user_id}:${now.date}`)) {
        const lines = [...today.map((ev: any) => `${hm(ev.s)} ${ev.title}`), ...dueToday.map((t: any) => `Due: ${t.title}`)];
        if (overdue) lines.push(`${overdue} overdue`);
        await send(subs, { title: `Today · ${today.length} event${today.length === 1 ? "" : "s"}`, body: lines.join("\n"), tag: `daily-${now.date}` });
        sent++;
      }
    }
  }

  // Tidy the sent-log once an hour
  if (new Date().getUTCMinutes() === 0) await db.from("notif_sent").delete().lt("sent_at", new Date(Date.now() - 30 * 864e5).toISOString());
  return Response.json({ sent });
});
