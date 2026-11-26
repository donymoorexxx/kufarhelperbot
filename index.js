// Kufar Helper — Telegram-бот + Mini App на Cloudflare Workers (webhook + Cron + D1)

import APP_HTML from "./app.html";
import { handleApi } from "./api.js";
import {
  passes, scoreAd, scoreBlock, priceChangeBlock, findRepost, sigOf, dsigOf, analogsFor,
  analyzeAd, aiText, rowToAd, money, median,
} from "./logic.js";

import { withEnv, U, flushUsage, getSetting, setSetting, logEvent, guardInfo, coreSchema, coreAlters, processBroadcasts } from "./core.js";

let APP_URL = ""; // адрес воркера для кнопок открытия Mini App

const MAX_CATS_PER_RUN = 3; // категорий за один запуск cron
const MAX_SENDS = 10; // уведомлений на категорию за проверку
const DEFAULT_INTERVAL = 5;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "ru-RU,ru;q=0.9",
};

// ───────────────────────── БД ─────────────────────────

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const p = (s) => env.DB.prepare(s);
  await env.DB.batch([
    p(`CREATE TABLE IF NOT EXISTS users(tg_id INTEGER PRIMARY KEY, paused INTEGER DEFAULT 0, interval INTEGER DEFAULT ${DEFAULT_INTERVAL}, state TEXT, state_data TEXT)`),
    p(`CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL, url TEXT NOT NULL, title TEXT,
      min_price REAL, max_price REAL, city TEXT, keywords TEXT, exclude TEXT, interval INTEGER DEFAULT ${DEFAULT_INTERVAL}, active INTEGER DEFAULT 1, last_check INTEGER DEFAULT 0)`),
    p(`CREATE TABLE IF NOT EXISTS seen(category_id INTEGER, ad_id TEXT, PRIMARY KEY(category_id, ad_id))`),
    p(`CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER, ad_id TEXT, title TEXT, price TEXT, url TEXT, ts INTEGER)`),
    p(`CREATE TABLE IF NOT EXISTS ads(ad_id TEXT PRIMARY KEY, market TEXT, title TEXT, price REAL, city TEXT, url TEXT, photo TEXT, descr TEXT, seller TEXT,
      cond TEXT, photos INTEGER, params INTEGER, list_time TEXT, first_seen INTEGER, sig TEXT, dsig TEXT, score INTEGER, dev REAL, dup_of TEXT)`),
    p(`CREATE INDEX IF NOT EXISTS ads_market ON ads(market, first_seen)`),
    p(`CREATE INDEX IF NOT EXISTS ads_seller ON ads(seller)`),
    p(`CREATE TABLE IF NOT EXISTS price_hist(ad_id TEXT, price REAL, ts INTEGER)`),
    p(`CREATE INDEX IF NOT EXISTS ph_ad ON price_hist(ad_id)`),
    p(`CREATE TABLE IF NOT EXISTS favs(tg_id INTEGER, ad_id TEXT, note TEXT, added INTEGER, price0 REAL, checked INTEGER DEFAULT 0, gone INTEGER DEFAULT 0, PRIMARY KEY(tg_id, ad_id))`),
    ...coreSchema(env),
  ]);
  const alters = [
    "ALTER TABLE categories ADD COLUMN cat_key TEXT", "ALTER TABLE categories ADD COLUMN since INTEGER",
    "ALTER TABLE categories ADD COLUMN market TEXT", "ALTER TABLE categories ADD COLUMN profile TEXT", "ALTER TABLE categories ADD COLUMN condition TEXT",
    "ALTER TABLE users ADD COLUMN quiet INTEGER DEFAULT 0", "ALTER TABLE users ADD COLUMN bl_words TEXT", "ALTER TABLE users ADD COLUMN bl_sellers TEXT",
    "ALTER TABLE users ADD COLUMN report TEXT DEFAULT 'off'", "ALTER TABLE users ADD COLUMN report_last TEXT", "ALTER TABLE users ADD COLUMN forward_chat INTEGER",
  ];
  for (const a of [...alters, ...coreAlters]) {
    try { await env.DB.prepare(a).run(); } catch {} // колонка уже есть
  }
  schemaReady = true;
}

const prep = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const all = async (env, sql, ...a) => (await prep(env, sql, ...a).all()).results;
const one = (env, sql, ...a) => prep(env, sql, ...a).first();
const run = (env, sql, ...a) => prep(env, sql, ...a).run();

async function ensureUser(env, id, info) {
  const now = Math.floor(Date.now() / 1000);
  await run(env, "INSERT OR IGNORE INTO users(tg_id, interval, created_at) VALUES(?, ?, ?)", id, DEFAULT_INTERVAL, now);
  const u = await one(env, "SELECT * FROM users WHERE tg_id=?", id);
  if (!u.last_seen || now - u.last_seen > 300 || (info && (info.username ?? null) !== (u.username ?? null))) {
    await run(env, "UPDATE users SET last_seen=?, username=COALESCE(?, username), first_name=COALESCE(?, first_name), created_at=COALESCE(created_at, ?) WHERE tg_id=?",
      now, info?.username ?? null, info?.first_name ?? null, now, id);
  }
  return u; // строка до обновления: по last_seen видно, давно ли пользователь заходил
}
async function batchChunks(env, stmts) {
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
}

// ───────────────────────── Telegram ─────────────────────────

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) console.log("tg error", method, JSON.stringify(j));
  return j;
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const B = (text, data) => ({ text, callback_data: data });
const kb = (rows) => ({ inline_keyboard: rows });
const backRow = [B("⬅️ В меню", "menu:home")];

const send = (env, chat, text, markup, silent) =>
  tg(env, "sendMessage", {
    chat_id: chat, text, parse_mode: "HTML", reply_markup: markup, disable_notification: !!silent,
    link_preview_options: { is_disabled: true },
  });

async function view(env, cb, text, markup) {
  const m = cb.message;
  const j = await tg(env, "editMessageText", {
    chat_id: m.chat.id, message_id: m.message_id, text, parse_mode: "HTML", reply_markup: markup,
    link_preview_options: { is_disabled: true },
  });
  if (!j.ok && !/not modified/i.test(j.description || "")) await send(env, m.chat.id, text, markup);
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
}

const webBtn = (text) => ({ text, web_app: { url: APP_URL } });
const mainMenu = () =>
  kb([
    [webBtn("📱 Открыть Kufar Helper")],
    [B("🔎 Начать мониторинг", "menu:start")],
    [B("📂 Мои категории", "menu:cats")],
    [B("⭐ Избранное", "menu:favs")],
    [B("📋 История объявлений", "menu:history")],
    [B("⏸ Приостановить мониторинг", "menu:pause")],
  ]);

// ───────────────────────── Kufar ─────────────────────────

function withSort(s) {
  const u = new URL(s);
  if (!u.searchParams.has("sort")) u.searchParams.set("sort", "lst.d");
  return u.toString();
}

function findAds(node, out) {
  if (Array.isArray(node)) return node.forEach((n) => findAds(n, out));
  if (node && typeof node === "object") {
    if ("ad_id" in node && "ad_link" in node) return out.push(node);
    Object.values(node).forEach((n) => findAds(n, out));
  }
}

// подпись параметра: сначала человекочитаемое v, потом значение vl
function param(ad, ...names) {
  const p = (ad.ad_parameters || []).find((x) => names.includes(x.p));
  const v = p ? (p.v ?? p.vl) : null;
  return Array.isArray(v) ? v.join(", ") : v;
}

function normalize(ad) {
  const pr = Number(ad.price_byn);
  const img = Array.isArray(ad.images) && ad.images[0]?.path;
  const city = [param(ad, "region"), param(ad, "area")].filter(Boolean).join(", ");
  return {
    id: String(ad.ad_id),
    title: String(ad.subject || "Без названия").slice(0, 160),
    price: pr > 0 ? pr / 100 : null,
    city: String(city),
    date: ad.list_time || "",
    desc: String(ad.body_short || ad.body || "").trim().slice(0, 400),
    url: ad.ad_link,
    photo: img ? `https://rms.kufar.by/v1/list_thumbs_2x/${img}` : null,
    seller: ad.account_id != null ? String(ad.account_id) : null,
    cond: param(ad, "condition") != null ? String(param(ad, "condition")) : null,
    photos: Array.isArray(ad.images) ? ad.images.length : 0,
    params: Array.isArray(ad.ad_parameters) ? ad.ad_parameters.length : 0,
  };
}

async function fetchAds(url) {
  const r = await fetch(withSort(url), { headers: HEADERS });
  if (!r.ok) throw new Error(`Kufar вернул HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("На странице не найдены данные объявлений (возможно, блокировка)");
  const found = [];
  findAds(JSON.parse(m[1]), found);
  const seen = new Set();
  return found.map(normalize).filter((a) => !seen.has(a.id) && seen.add(a.id));
}

// Цена именно этого объявления (а не похожих на странице): ищем объект с тем же ad_id
function findPrice(node, adId) {
  if (Array.isArray(node)) { for (const n of node) { const v = findPrice(n, adId); if (v != null) return v; } return null; }
  if (node && typeof node === "object") {
    if ("price_byn" in node && String(node.ad_id ?? node.adId ?? node.id) === String(adId)) {
      const p = Number(node.price_byn);
      return p > 0 ? p / 100 : null;
    }
    for (const n of Object.values(node)) { const v = findPrice(n, adId); if (v != null) return v; }
  }
  return null;
}

function fmtDate(s, year = true) {
  const d = new Date(s);
  if (!s || isNaN(d)) return s || "—";
  return d.toLocaleString("ru-RU", {
    timeZone: "Europe/Minsk", day: "2-digit", month: "2-digit", ...(year ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit",
  });
}

const priceStr = (a) => (a.price != null ? `${Math.round(a.price)} BYN` : "договорная");

function adCard(ad, sc, extra) {
  const d = ad.desc.length > 150 ? esc(ad.desc.slice(0, 150)) + "…" : esc(ad.desc);
  return (
    `<b>${esc(ad.title)}</b>\n💰 ${priceStr(ad)}\n📍 ${esc(ad.city || "—")}\n🕒 ${fmtDate(ad.date)}` +
    (d ? `\n\n${d}` : "") + `\n\n${scoreBlock(ad, sc)}` + (extra ? `\n\n${extra}` : "")
  );
}

function adButtons(env, ad) {
  const rows = [[{ text: "Открыть на Kufar", url: ad.url }]];
  const r2 = [B("⭐ В избранное", `fav:${ad.id}`)];
  if (env.AI || env.GROQ_API_KEY || env.GEMINI_API_KEY || env.OPENROUTER_API_KEY) r2.push(B("🤖 AI-анализ", `ai:${ad.id}`));
  rows.push(r2);
  if (ad.seller) rows.push([B("🚫 Скрыть продавца", `bls:${ad.id}`)]);
  return kb(rows);
}

async function sendAd(env, chat, ad, text, markup, silent) {
  if (ad.photo) {
    const j = await tg(env, "sendPhoto", {
      chat_id: chat, photo: ad.photo, caption: text, parse_mode: "HTML", reply_markup: markup, disable_notification: !!silent,
    });
    if (j.ok) return j;
  }
  return send(env, chat, text, markup, silent);
}

// ───────────────────────── Чат с ботом ─────────────────────────

async function onMessage(env, msg) {
  if (msg.chat.type !== "private") return;
  const id = msg.from.id;
  const u = await ensureUser(env, id, msg.from);
  if (u.blocked) return;
  if ((await getSetting(env, "maintenance", "0")) === "1" && String(id) !== String(env.OWNER_TELEGRAM_ID)) {
    return send(env, id, "🛠 Идут технические работы. Мониторинг продолжает работать, приложение скоро вернётся.");
  }
  const text = (msg.text || "").trim();
  if (text.startsWith("/start") || text.startsWith("/menu")) {
    return send(env, id, "Привет! Я слежу за новыми объявлениями на Kufar, оцениваю цены и присылаю находки сюда.\nВсе настройки в приложении 👇", mainMenu());
  }
  return send(env, id, "Выбери действие в меню:", mainMenu());
}

async function catList(env, id) {
  const rows = await all(env, "SELECT * FROM categories WHERE tg_id=? ORDER BY id DESC", id);
  const list = rows.map((x) => [B(`${x.active ? "🟢" : "⚪️"} ${x.title}`, `toggle:${x.id}`)]);
  return { rows, markup: kb([...list, [webBtn("➕ Добавить / настроить в приложении")], backRow]) };
}

async function onCallback(env, cb) {
  const id = cb.from.id;
  const [a, b] = (cb.data || "").split(":");
  const user = await ensureUser(env, id, cb.from);
  if (user.blocked) return tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  const key = a === "menu" ? `menu:${b}` : a;
  const toast = (t, alert = false) => tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: t, show_alert: alert });

  switch (key) {
    case "menu:home":
      return view(env, cb, "Главное меню:", mainMenu());

    case "menu:start": {
      if (user.paused) {
        return view(env, cb, "▶️ Включаю мониторинг. Что сделать с объявлениями, которые появились, пока он был выключен?",
          kb([[B("Только новые", "resume:new")], [B("Прислать пропущенные", "resume:all")], backRow]));
      }
      const n = (await one(env, "SELECT COUNT(*) c FROM categories WHERE tg_id=? AND active=1", id)).c;
      return view(env, cb, `🔎 Мониторинг уже работает. Активных категорий: ${n}`, mainMenu());
    }

    case "resume": {
      const now = Math.floor(Date.now() / 1000);
      await run(env, "UPDATE users SET paused=0 WHERE tg_id=?", id);
      await run(env, "UPDATE categories SET since=?, last_check=0 WHERE tg_id=? AND active=1", b === "new" ? now : null, id);
      const n = (await one(env, "SELECT COUNT(*) c FROM categories WHERE tg_id=? AND active=1", id)).c;
      return view(env, cb, (n ? "🔎 Мониторинг запущен." : "Мониторинг включён, но категорий пока нет.") + `\nАктивных категорий: ${n}`, mainMenu());
    }

    case "menu:pause":
      await run(env, "UPDATE users SET paused=1 WHERE tg_id=?", id);
      return view(env, cb, "⏸ Мониторинг приостановлен. Нажми «Начать мониторинг», чтобы продолжить.", mainMenu());

    case "menu:cats": {
      const { rows, markup } = await catList(env, id);
      return view(env, cb, rows.length ? "📂 Твои категории (нажми, чтобы включить или выключить):" : "Категорий пока нет. Добавь в приложении.", markup);
    }

    case "toggle": {
      const cat = await one(env, "SELECT * FROM categories WHERE id=? AND tg_id=?", Number(b), id);
      if (!cat) return toast("Категория не найдена", true);
      if (cat.active) await run(env, "UPDATE categories SET active=0 WHERE id=?", cat.id);
      else await run(env, "UPDATE categories SET active=1, since=?, last_check=0 WHERE id=?", Math.floor(Date.now() / 1000), cat.id);
      const { markup } = await catList(env, id);
      return view(env, cb, "📂 Твои категории (при включении старые объявления пропускаются):", markup);
    }

    case "menu:favs": {
      const rows = await all(env, "SELECT f.ad_id, f.price0, a.title, a.price, a.url FROM favs f JOIN ads a ON a.ad_id=f.ad_id WHERE f.tg_id=? ORDER BY f.added DESC LIMIT 15", id);
      const text = rows.length
        ? "⭐ <b>Избранное:</b>\n\n" + rows.map((r) => `• <a href="${esc(r.url)}">${esc(r.title)}</a> — ${money(r.price)}${r.price0 != null && r.price0 !== r.price ? ` (было ${money(r.price0)})` : ""}`).join("\n")
        : "В избранном пусто. Нажми «⭐ В избранное» под объявлением.";
      return view(env, cb, text, kb([backRow]));
    }

    case "menu:history": {
      const rows = await all(env, "SELECT * FROM history WHERE tg_id=? ORDER BY id DESC LIMIT 10", id);
      const text = rows.length
        ? "📋 <b>Последние объявления:</b>\n\n" + rows.map((r) => `• <a href="${esc(r.url)}">${esc(r.title)}</a> — ${esc(r.price)} (${fmtDate(r.ts * 1000, false)})`).join("\n")
        : "История пока пуста.";
      return view(env, cb, text, kb([backRow]));
    }

    case "fav": {
      const ad = await one(env, "SELECT ad_id, price FROM ads WHERE ad_id=?", b);
      if (!ad) return toast("Объявление не найдено", true);
      await run(env, "INSERT OR IGNORE INTO favs(tg_id,ad_id,added,price0) VALUES(?,?,?,?)", id, b, Math.floor(Date.now() / 1000), ad.price);
      return toast("⭐ Добавлено в избранное. Слежу за ценой");
    }

    case "bls": {
      const ad = await one(env, "SELECT seller FROM ads WHERE ad_id=?", b);
      if (!ad?.seller) return toast("Продавец неизвестен", true);
      const list = String(user.bl_sellers || "").split(",").filter(Boolean);
      if (!list.includes(ad.seller)) list.push(ad.seller);
      await run(env, "UPDATE users SET bl_sellers=? WHERE tg_id=?", list.join(","), id);
      return toast("🚫 Продавец скрыт. Его объявления больше не придут", true);
    }

    case "ai": {
      const row = await one(env, "SELECT * FROM ads WHERE ad_id=?", b);
      if (!row) return toast("Объявление не найдено", true);
      await toast("🤖 Анализирую…");
      try {
        await send(env, id, aiText(await analyzeAd(env, row, id)));
      } catch (e) {
        await send(env, id, `Не получилось: ${esc(e.message)}`);
      }
      return;
    }

    default:
      return toast("");
  }
}

// ───────────────────────── Мониторинг (cron) ─────────────────────────

async function checkCategory(env, cat) {
  const now = Math.floor(Date.now() / 1000);
  // захватываем категорию: если другой запуск Cron уже взял её, пропускаем
  const claim = await run(env, "UPDATE categories SET last_check=? WHERE id=? AND last_check + interval*60 <= ?", now, cat.id, now);
  if (claim.meta.changes === 0) return;

  let ads;
  try { ads = await fetchAds(cat.url); } catch (e) {
    console.log("fetch failed", cat.id, e.message);
    if (cat.last_error !== e.message.slice(0, 120)) {
      await run(env, "UPDATE categories SET last_error=? WHERE id=?", e.message.slice(0, 120), cat.id);
      await logEvent(env, "cron_error", cat.tg_id, `категория ${cat.id}: ${e.message}`);
    }
    return;
  }
  await run(env, "UPDATE categories SET last_ok=?, last_error=NULL WHERE id=?", now, cat.id);
  if (!ads.length) return;

  const user = await one(env, "SELECT * FROM users WHERE tg_id=?", cat.tg_id);
  const market = cat.market || cat.cat_key || `c${cat.id}`;
  const idList = ads.map((a) => a.id).slice(0, 90);
  const ph = idList.map(() => "?").join(",");
  const [seenRows, knownRows] = await Promise.all([
    all(env, "SELECT ad_id FROM seen WHERE category_id=?", cat.id),
    all(env, `SELECT ad_id, price FROM ads WHERE ad_id IN (${ph})`, ...idList),
  ]);
  const seen = new Set(seenRows.map((r) => r.ad_id));
  const known = new Map(knownRows.map((r) => [r.ad_id, r]));
  const fresh = ads.filter((a) => !seen.has(a.id));
  const changed = ads.filter((a) => {
    const k = known.get(a.id);
    return k && a.price != null && k.price != null && Math.abs(a.price - k.price) >= 0.01;
  });
  if (!fresh.length && !changed.length) return;

  const silent = !!user?.quiet;
  const fwd = user?.forward_chat;
  const notOld = (a) => {
    if (!cat.since || !a.date) return true;
    const t = Date.parse(a.date) / 1000;
    return !Number.isFinite(t) || t >= cat.since;
  };
  const toSend = fresh.slice(0, MAX_SENDS).reverse().filter((a) => notOld(a) && passes(a, cat, user));
  const deferred = new Set(toSend.map((a) => a.id)); // «просмотренными» станут только после успешной отправки

  const pool = await all(env, "SELECT ad_id,title,price,sig,dsig,seller,first_seen FROM ads WHERE market=? ORDER BY first_seen DESC LIMIT 600", market);
  const stmts = [];
  const meta = new Map();

  for (const a of fresh) {
    const sc = scoreAd(a, analogsFor(a, pool));
    let rp = null;
    if (!known.has(a.id)) {
      const sig = sigOf(a.title), dsig = dsigOf(a.desc);
      rp = findRepost(a, sig, dsig, a.seller, pool);
      U.newAds++;
      stmts.push(prep(env,
        "INSERT OR IGNORE INTO ads(ad_id,market,title,price,city,url,photo,descr,seller,cond,photos,params,list_time,first_seen,sig,dsig,score,dev,dup_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        a.id, market, a.title, a.price, a.city, a.url, a.photo, a.desc, a.seller, a.cond, a.photos, a.params, a.date, now, sig, dsig, sc.score, sc.dev, rp ? rp.row.ad_id : null));
      if (a.price != null) stmts.push(prep(env, "INSERT INTO price_hist VALUES(?,?,?)", a.id, a.price, now));
      pool.unshift({ ad_id: a.id, title: a.title, price: a.price, sig, dsig, seller: a.seller, first_seen: now });
    }
    if (!deferred.has(a.id)) stmts.push(prep(env, "INSERT OR IGNORE INTO seen VALUES(?,?)", cat.id, a.id));
    meta.set(a.id, { sc, rp });
  }

  const drops = [];
  for (const a of changed) {
    const old = known.get(a.id).price;
    const sc = scoreAd(a, analogsFor(a, pool));
    stmts.push(prep(env, "UPDATE ads SET price=?, score=?, dev=? WHERE ad_id=?", a.price, sc.score, sc.dev, a.id));
    stmts.push(prep(env, "INSERT INTO price_hist VALUES(?,?,?)", a.id, a.price, now));
    drops.push({ a, old, sc });
  }
  await batchChunks(env, stmts);

  // новые объявления
  const hist = [];
  for (const ad of toSend) {
    const { sc, rp } = meta.get(ad.id);
    const extra = rp
      ? `🔁 Вероятная повторная публикация (${rp.kind === "repost" ? "тот же продавец" : "похожее объявление другого продавца"}). Раньше замечено: ${fmtDate(rp.row.first_seen * 1000)}, цена тогда: ${money(rp.row.price)}`
      : "";
    const text = adCard(ad, sc, extra);
    const res = await sendAd(env, cat.tg_id, ad, text, adButtons(env, ad), silent);
    if (res.ok) {
      U.sent++;
      hist.push(prep(env, "UPDATE users SET sent_total=COALESCE(sent_total,0)+1 WHERE tg_id=?", cat.tg_id));
      hist.push(prep(env, "INSERT OR IGNORE INTO seen VALUES(?,?)", cat.id, ad.id));
      hist.push(prep(env, "INSERT INTO history(tg_id,ad_id,title,price,url,ts) VALUES(?,?,?,?,?,?)", cat.tg_id, ad.id, ad.title, priceStr(ad), ad.url, now));
      if (fwd) await sendAd(env, fwd, ad, text, kb([[{ text: "Открыть на Kufar", url: ad.url }]]), true);
    } else if (res.error_code === 403) {
      // пользователь заблокировал бота: ставим мониторинг на паузу, чтобы не долбиться впустую
      hist.push(prep(env, "UPDATE users SET paused=1 WHERE tg_id=?", cat.tg_id));
      break;
    }
    // иначе объявление остаётся непросмотренным и придёт при следующей проверке
  }

  // изменения цены: для избранного в обе стороны, для остальных только снижение от 10%
  if (drops.length) {
    const favRows = await all(env, `SELECT ad_id FROM favs WHERE tg_id=? AND ad_id IN (${drops.map(() => "?").join(",")})`, cat.tg_id, ...drops.map((d) => d.a.id));
    const favSet = new Set(favRows.map((r) => r.ad_id));
    let n = 0;
    for (const d of drops) {
      if (n >= 5) break;
      const change = (d.a.price - d.old) / d.old;
      if (!(favSet.has(d.a.id) || (change <= -0.1 && seen.has(d.a.id) && passes(d.a, cat, user)))) continue;
      const text = `${priceChangeBlock(d.old, d.a.price)}\n\n<b>${esc(d.a.title)}</b>\n📍 ${esc(d.a.city || "—")}\n\n${scoreBlock(d.a, d.sc)}`;
      if ((await sendAd(env, cat.tg_id, d.a, text, adButtons(env, d.a), silent)).ok) n++;
    }
  }

  hist.push(prep(env, "DELETE FROM seen WHERE category_id=? AND rowid NOT IN (SELECT rowid FROM seen WHERE category_id=? ORDER BY rowid DESC LIMIT 500)", cat.id, cat.id));
  hist.push(prep(env, "DELETE FROM history WHERE tg_id=? AND id NOT IN (SELECT id FROM history WHERE tg_id=? ORDER BY id DESC LIMIT 200)", cat.tg_id, cat.tg_id));
  await batchChunks(env, hist);
}

// Избранное: раз в 30 минут заглядываем в само объявление (по одному за запуск)
async function refreshFavorite(env) {
  const now = Math.floor(Date.now() / 1000);
  const f = await one(env,
    "SELECT f.tg_id, f.ad_id, a.url, a.price, a.title FROM favs f JOIN ads a ON a.ad_id=f.ad_id WHERE f.gone=0 AND f.checked < ? ORDER BY f.checked LIMIT 1", now - 1800);
  if (!f) return;
  await run(env, "UPDATE favs SET checked=? WHERE tg_id=? AND ad_id=?", now, f.tg_id, f.ad_id);
  let r;
  try { r = await fetch(f.url, { headers: HEADERS }); } catch { return; }
  if (r.status === 404 || r.status === 410) {
    await run(env, "UPDATE favs SET gone=1 WHERE tg_id=? AND ad_id=?", f.tg_id, f.ad_id);
    return send(env, f.tg_id, `🗑 Объявление из избранного удалено или снято:\n<b>${esc(f.title)}</b>`);
  }
  if (!r.ok) return;
  const m = (await r.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return;
  let price = null;
  try { price = findPrice(JSON.parse(m[1]), f.ad_id); } catch {}
  if (price == null || f.price == null || Math.abs(price - f.price) < 0.01) return;
  await env.DB.batch([
    prep(env, "UPDATE ads SET price=? WHERE ad_id=?", price, f.ad_id),
    prep(env, "INSERT INTO price_hist VALUES(?,?,?)", f.ad_id, price, now),
  ]);
  await send(env, f.tg_id, `${priceChangeBlock(f.price, price)}\n\n<b>${esc(f.title)}</b>\n<a href="${esc(f.url)}">Открыть на Kufar</a>`);
}

// Отчёты за день и неделю (в 9:00 по Минску)
async function sendReports(env) {
  const mt = new Date(Date.now() + 3 * 3600e3);
  const date = mt.toISOString().slice(0, 10);
  if (mt.getUTCHours() < 9) return;
  const users = await all(env, "SELECT tg_id, report FROM users WHERE report IN ('daily','weekly') AND (report_last IS NULL OR report_last != ?) LIMIT 5", date);
  for (const u of users) {
    if (u.report === "weekly" && mt.getUTCDay() !== 1) continue;
    const days = u.report === "weekly" ? 7 : 1;
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const [found, top, drops] = await Promise.all([
      one(env, "SELECT COUNT(*) c FROM history WHERE tg_id=? AND ts>=?", u.tg_id, since),
      all(env, `SELECT a.title,a.price,a.score,a.url FROM ads a WHERE a.first_seen>=? AND a.score IS NOT NULL AND a.ad_id IN
        (SELECT s.ad_id FROM seen s JOIN categories c ON c.id=s.category_id WHERE c.tg_id=?) ORDER BY a.score DESC LIMIT 3`, since, u.tg_id),
      one(env, `SELECT COUNT(DISTINCT p.ad_id) c FROM price_hist p JOIN favs f ON f.ad_id=p.ad_id AND f.tg_id=? WHERE p.ts>=?`, u.tg_id, since),
    ]);
    const text =
      `📊 <b>Отчёт за ${days === 1 ? "сутки" : "неделю"}</b>\n\nПрислано объявлений: ${found.c}\nИзменений цены в избранном: ${drops.c}\n` +
      (top.length ? "\n🔥 Лучшие находки:\n" + top.map((t) => `• <a href="${esc(t.url)}">${esc(t.title)}</a> — ${money(t.price)} (оценка ${t.score}/100)`).join("\n") : "\nЛучших находок пока нет: мало данных для сравнения цен.");
    await send(env, u.tg_id, text, undefined, true);
    await run(env, "UPDATE users SET report_last=? WHERE tg_id=?", date, u.tg_id);
  }
}

async function runMonitor(env) {
  const t0 = Date.now();
  await ensureSchema(env);
  U.cron++;
  const now = Math.floor(t0 / 1000);
  // Resource Guard: при приближении к дневным лимитам второстепенное откладывается, мониторинг остаётся главным
  const g = await guardInfo(env, true);
  const level = g.level;
  const maxCats = level >= 95 ? 1 : level >= 85 ? 2 : MAX_CATS_PER_RUN;
  const cats = await all(env,
    `SELECT c.* FROM categories c JOIN users u ON u.tg_id=c.tg_id
     WHERE c.active=1 AND u.paused=0 AND u.blocked=0 AND c.last_check + c.interval*60 <= ? ORDER BY c.last_check ASC LIMIT ?`, now, maxCats);
  let checked = 0, errors = 0;
  for (const cat of cats) {
    try { await checkCategory(env, cat); checked++; } catch (e) {
      errors++;
      console.log("check error", cat.id, e.message, e.stack);
      await logEvent(env, "cron_error", cat.tg_id, `категория ${cat.id}: ${e.message}`);
    }
  }
  if (level < 85) {
    try { await refreshFavorite(env); } catch (e) { console.log("fav error", e.message); }
    try { await processBroadcasts(env, (chat, text) => tg(env, "sendMessage", { chat_id: chat, text, disable_web_page_preview: true })); } catch (e) { console.log("broadcast error", e.message); await logEvent(env, "cron_error", null, `рассылка: ${e.message}`); }
  }
  if (level < 70) {
    try { await sendReports(env); } catch (e) { console.log("report error", e.message); }
  }
  if (Math.random() < 0.01) {
    // чистим старое: объявления старше 90 дней (кроме избранного), старые события, метрики и AI-логи
    await env.DB.batch([
      prep(env, "DELETE FROM ads WHERE first_seen<? AND ad_id NOT IN (SELECT ad_id FROM favs)", now - 90 * 86400),
      prep(env, "DELETE FROM price_hist WHERE ad_id NOT IN (SELECT ad_id FROM ads)"),
      prep(env, "DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 5000)"),
      prep(env, "DELETE FROM usage WHERE h < ?", new Date((now - 100 * 86400) * 1000).toISOString().slice(0, 13)),
      prep(env, "DELETE FROM ai_log WHERE ts < ?", now - 30 * 86400),
    ]).catch((e) => console.log("cleanup", e.message));
  }
  // Предупреждение владельцу при 70/85/95% дневного лимита (по одному разу на уровень в сутки)
  if (level > 0 && env.OWNER_TELEGRAM_ID) {
    const key = `guard.alert.${new Date().toISOString().slice(0, 10)}`;
    if (level > Number(await getSetting(env, key, "0"))) {
      await setSetting(env, key, level);
      const what = level >= 95 ? "За запуск проверяется 1 категория, всё второстепенное отложено." : level >= 85 ? "AI, рассылки и проверка избранного приостановлены." : "Отчёты отложены.";
      await send(env, env.OWNER_TELEGRAM_ID, `⚠️ <b>Resource Guard</b>: израсходовано около ${Math.round(g.pct * 100)}% дневного лимита Cloudflare (порог ${level}%).\n${what}\nМониторинг продолжает работать.`);
    }
  }
  const last = JSON.parse((await getSetting(env, "cron.last", "null")) || "null");
  if (!last || now - last.ts >= 120 || errors) await setSetting(env, "cron.last", JSON.stringify({ ts: now, ms: Date.now() - t0, cats: checked, errors, level }));
  await flushUsage(env);
}

// ───────────────────────── Точки входа ─────────────────────────

export default {
  async fetch(request, env, ctx) {
    env = withEnv(env); // считаем обращения к D1 для Resource Guard
    U.requests++;
    ctx.waitUntil(flushUsage(env));
    const url = new URL(request.url);
    APP_URL = url.origin;

    if (url.pathname === "/" || url.pathname === "/app") {
      return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    if (url.pathname.startsWith("/api/")) {
      await ensureSchema(env);
      return handleApi(request, env, url, { prep, all, one, run, tg, fetchAds, ensureUser, batchChunks, analyzeAd, aiText });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const update = await request.json();
      ctx.waitUntil((async () => {
        try {
          await ensureSchema(env);
          if (update.message) await onMessage(env, update.message);
          else if (update.callback_query) await onCallback(env, update.callback_query);
        } catch (e) {
          console.log("update error", e.message, e.stack);
        }
      })());
      return new Response("ok");
    }

    const authorized = env.WEBHOOK_SECRET && url.searchParams.get("key") === env.WEBHOOK_SECRET;

    // Один раз открыть: /setup?key=<WEBHOOK_SECRET>
    if (url.pathname === "/setup") {
      if (!authorized) return new Response("Нужен ?key=<WEBHOOK_SECRET>", { status: 403 });
      const j = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
      });
      await tg(env, "setMyCommands", { commands: [{ command: "start", description: "Главное меню" }] });
      await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "Kufar", web_app: { url: url.origin } } });
      return new Response(j.ok ? "✅ Webhook установлен. Напиши боту /start" : "❌ " + JSON.stringify(j), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    // Проверка доступа к Kufar: /test?key=...&url=https://www.kufar.by/l/...
    if (url.pathname === "/test") {
      if (!authorized) return new Response("Нужен ?key=<WEBHOOK_SECRET>", { status: 403 });
      try {
        const ads = await fetchAds(url.searchParams.get("url") || "");
        return Response.json({ ok: true, count: ads.length, first: ads.slice(0, 3).map((a) => ({ title: a.title, price: a.price, city: a.city, seller: a.seller, cond: a.cond })) });
      } catch (e) {
        return Response.json({ ok: false, error: e.message });
      }
    }

    return new Response("Kufar bot работает");
  },

  async scheduled(event, env, ctx) {
    env = withEnv(env);
    ctx.waitUntil(runMonitor(env));
  },
};

export { median };
