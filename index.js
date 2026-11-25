// Kufar monitor — Telegram-бот на Cloudflare Workers (webhook + Cron + D1)

const MAX_CATS_PER_RUN = 3; // сколько категорий проверять за один запуск cron
const MAX_SENDS = 10; // максимум уведомлений на категорию за проверку
const DEFAULT_INTERVAL = 5; // минут

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "ru-RU,ru;q=0.9",
};

const FIELDS = {
  min_price: ["Мин. цена (BYN)", "число"],
  max_price: ["Макс. цена (BYN)", "число"],
  city: ["Город", "текст, например: Минск"],
  keywords: ["Ключевые слова", "через запятую; нужно хотя бы одно"],
  exclude: ["Исключаемые слова", "через запятую"],
  interval: ["Интервал проверки (мин)", "число от 1 до 1440"],
};

// ───────────────────────── БД ─────────────────────────

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const p = (s) => env.DB.prepare(s);
  await env.DB.batch([
    p(`CREATE TABLE IF NOT EXISTS users(
      tg_id INTEGER PRIMARY KEY, paused INTEGER DEFAULT 0, interval INTEGER DEFAULT ${DEFAULT_INTERVAL},
      state TEXT, state_data TEXT)`),
    p(`CREATE TABLE IF NOT EXISTS categories(
      id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL, url TEXT NOT NULL, title TEXT,
      min_price REAL, max_price REAL, city TEXT, keywords TEXT, exclude TEXT,
      interval INTEGER DEFAULT ${DEFAULT_INTERVAL}, active INTEGER DEFAULT 1, last_check INTEGER DEFAULT 0)`),
    p(`CREATE TABLE IF NOT EXISTS seen(category_id INTEGER, ad_id TEXT, PRIMARY KEY(category_id, ad_id))`),
    p(`CREATE TABLE IF NOT EXISTS history(
      id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER, ad_id TEXT, title TEXT, price TEXT, url TEXT, ts INTEGER)`),
  ]);
  schemaReady = true;
}

const prep = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const all = async (env, sql, ...a) => (await prep(env, sql, ...a).all()).results;
const one = (env, sql, ...a) => prep(env, sql, ...a).first();
const run = (env, sql, ...a) => prep(env, sql, ...a).run();

async function ensureUser(env, id) {
  await run(env, "INSERT OR IGNORE INTO users(tg_id, interval) VALUES(?, ?)", id, DEFAULT_INTERVAL);
  return one(env, "SELECT * FROM users WHERE tg_id=?", id);
}
const setState = (env, id, state, data = null) =>
  run(env, "UPDATE users SET state=?, state_data=? WHERE tg_id=?", state, data ? JSON.stringify(data) : null, id);
const getCat = (env, id, tg) => one(env, "SELECT * FROM categories WHERE id=? AND tg_id=?", id, tg);

// ───────────────────────── Telegram ─────────────────────────

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) console.log("tg error", method, JSON.stringify(j));
  return j;
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const B = (text, data) => ({ text, callback_data: data });
const kb = (rows) => ({ inline_keyboard: rows });
const backRow = [B("⬅️ В меню", "menu:home")];

const send = (env, chat, text, markup) =>
  tg(env, "sendMessage", {
    chat_id: chat,
    text,
    parse_mode: "HTML",
    reply_markup: markup,
    link_preview_options: { is_disabled: true },
  });

async function view(env, cb, text, markup) {
  const m = cb.message;
  const j = await tg(env, "editMessageText", {
    chat_id: m.chat.id,
    message_id: m.message_id,
    text,
    parse_mode: "HTML",
    reply_markup: markup,
    link_preview_options: { is_disabled: true },
  });
  if (!j.ok && !/not modified/i.test(j.description || "")) await send(env, m.chat.id, text, markup);
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
}

const mainMenu = () =>
  kb([
    [B("🔎 Начать мониторинг", "menu:start")],
    [B("📂 Мои категории", "menu:cats")],
    [B("➕ Добавить категорию", "menu:add")],
    [B("⚙️ Настройки", "menu:settings")],
    [B("📋 История объявлений", "menu:history")],
    [B("⏸ Приостановить мониторинг", "menu:pause")],
  ]);

function catKb(c) {
  const f = (k) => B(FIELDS[k][0], `edit:${c.id}:${k}`);
  return kb([
    [f("min_price"), f("max_price")],
    [f("city"), f("keywords")],
    [f("exclude"), f("interval")],
    [B(c.active ? "⏸ Выключить" : "▶️ Включить", `toggle:${c.id}`), B("🗑 Удалить", `del:${c.id}`)],
    [B("⬅️ К категориям", "menu:cats")],
  ]);
}

function catText(c) {
  const v = (x, s = "") => (x === null || x === undefined || x === "" ? "—" : `${x}${s}`);
  return (
    `<b>${esc(c.title || "Категория")}</b>\n${c.active ? "🟢 Активна" : "⚪️ Выключена"}\n\n` +
    `Мин. цена: ${v(c.min_price, " BYN")}\nМакс. цена: ${v(c.max_price, " BYN")}\n` +
    `Город: ${esc(v(c.city))}\nКлючевые слова: ${esc(v(c.keywords))}\n` +
    `Исключить: ${esc(v(c.exclude))}\nИнтервал: ${c.interval} мин`
  );
}

// ───────────────────────── Kufar ─────────────────────────

function validKufarUrl(s) {
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) && /(^|\.)kufar\.by$/.test(u.hostname) && u.pathname.startsWith("/l");
  } catch {
    return false;
  }
}

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

function param(ad, ...names) {
  const p = (ad.ad_parameters || []).find((x) => names.includes(x.p));
  return p ? (p.vl ?? p.v) : null;
}

function normalize(ad) {
  const pr = Number(ad.price_byn);
  const img = Array.isArray(ad.images) && ad.images[0]?.path;
  let city = param(ad, "area", "region") ?? "";
  if (Array.isArray(city)) city = city.join(", ");
  return {
    id: String(ad.ad_id),
    title: ad.subject || "Без названия",
    price: pr > 0 ? pr / 100 : null,
    city: String(city),
    date: ad.list_time || "",
    desc: String(ad.body_short || ad.body || "").trim(),
    url: ad.ad_link,
    photo: img ? `https://rms.kufar.by/v1/list_thumbs_2x/${img}` : null,
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

const csv = (s) => String(s || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

function passes(ad, c) {
  if (c.min_price != null && (ad.price == null || ad.price < c.min_price)) return false;
  if (c.max_price != null && (ad.price == null || ad.price > c.max_price)) return false;
  if (c.city && !ad.city.toLowerCase().includes(c.city.toLowerCase())) return false;
  const text = `${ad.title} ${ad.desc}`.toLowerCase();
  const kws = csv(c.keywords);
  if (kws.length && !kws.some((k) => text.includes(k))) return false;
  if (csv(c.exclude).some((k) => text.includes(k))) return false;
  return true;
}

function fmtDate(s, year = true) {
  const d = new Date(s);
  if (!s || isNaN(d)) return s || "—";
  return d.toLocaleString("ru-RU", {
    timeZone: "Europe/Minsk",
    day: "2-digit",
    month: "2-digit",
    ...(year ? { year: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  });
}

const priceStr = (a) => (a.price != null ? `${Math.round(a.price)} BYN` : "договорная");

function adText(a) {
  const d = a.desc.length > 200 ? esc(a.desc.slice(0, 200)) + "…" : esc(a.desc);
  return (
    `<b>${esc(a.title)}</b>\n💰 ${priceStr(a)}\n📍 ${esc(a.city || "—")}\n🕒 ${fmtDate(a.date)}` +
    (d ? `\n\n${d}` : "")
  );
}

async function sendAd(env, chat, ad) {
  const markup = kb([[{ text: "Открыть на Kufar", url: ad.url }]]);
  if (ad.photo) {
    const j = await tg(env, "sendPhoto", {
      chat_id: chat,
      photo: ad.photo,
      caption: adText(ad),
      parse_mode: "HTML",
      reply_markup: markup,
    });
    if (j.ok) return true;
  }
  return (await send(env, chat, adText(ad), markup)).ok;
}

// ───────────────────────── Обработка сообщений ─────────────────────────

async function onMessage(env, msg) {
  if (msg.chat.type !== "private") return;
  const id = msg.from.id;
  const text = (msg.text || "").trim();
  const user = await ensureUser(env, id);

  if (text.startsWith("/start") || text.startsWith("/menu")) {
    await setState(env, id, null);
    return send(env, id, "Привет! Я слежу за новыми объявлениями на Kufar и присылаю их сюда.\nВыбери действие:", mainMenu());
  }

  if (user.state === "waiting_url") return gotUrl(env, id, text, user);
  if (user.state === "waiting_value") return gotValue(env, id, text, JSON.parse(user.state_data || "{}"));
  return send(env, id, "Выбери действие в меню:", mainMenu());
}

async function gotUrl(env, id, text, user) {
  if (!validKufarUrl(text)) return send(env, id, "Это не похоже на ссылку Kufar (kufar.by/l/...). Попробуй ещё раз.");
  let ads;
  try {
    ads = await fetchAds(text);
  } catch (e) {
    return send(env, id, `Не получилось прочитать ссылку: ${esc(e.message)}\nПроверь её и отправь снова.`);
  }
  const last = decodeURIComponent(new URL(text).pathname.replace(/\/$/, "").split("/").pop() || "");
  const title = (last.replace(/-/g, " ") || "Категория").replace(/^./, (c) => c.toUpperCase());
  const res = await run(
    env,
    "INSERT INTO categories(tg_id,url,title,interval) VALUES(?,?,?,?)",
    id, text, title, user.interval
  );
  const catId = res.meta.last_row_id;
  if (ads.length) {
    await env.DB.batch(ads.map((a) => prep(env, "INSERT OR IGNORE INTO seen VALUES(?,?)", catId, a.id)));
  }
  await setState(env, id, null);
  const cat = await getCat(env, catId, id);
  return send(
    env, id,
    `✅ Категория добавлена и включена в мониторинг.\nСейчас на странице объявлений: ${ads.length} (о них уведомлять не буду).\n\nХочешь настроить фильтры?\n\n${catText(cat)}`,
    catKb(cat)
  );
}

async function gotValue(env, id, text, data) {
  const { cat_id: catId, field } = data;
  if (!(field in FIELDS)) {
    await setState(env, id, null);
    return send(env, id, "Что-то пошло не так.", mainMenu());
  }
  let value = null;
  if (!(text === "-" && field !== "interval")) {
    if (["min_price", "max_price", "interval"].includes(field)) {
      let n = Number(text.replace(",", "."));
      if (!Number.isFinite(n) || n < 0 || text === "") return send(env, id, "Нужно число. Попробуй ещё раз.");
      if (field === "interval") {
        n = Math.floor(n);
        if (n < 1 || n > 1440) return send(env, id, "Интервал от 1 до 1440 минут.");
      }
      value = n;
    } else value = text;
  }
  if (!(await getCat(env, catId, id))) {
    await setState(env, id, null);
    return send(env, id, "Категория не найдена.", mainMenu());
  }
  await run(env, `UPDATE categories SET ${field}=? WHERE id=?`, value, catId);
  await setState(env, id, null);
  const cat = await getCat(env, catId, id);
  return send(env, id, "✅ Сохранено.\n\n" + catText(cat), catKb(cat));
}

async function onCallback(env, cb) {
  const id = cb.from.id;
  const [a, b, c] = (cb.data || "").split(":");
  const user = await ensureUser(env, id);
  const key = a === "menu" ? `menu:${b}` : a;
  const alert = (t) => tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: t, show_alert: true });

  switch (key) {
    case "menu:home":
      await setState(env, id, null);
      return view(env, cb, "Главное меню:", mainMenu());

    case "menu:start": {
      await run(env, "UPDATE users SET paused=0 WHERE tg_id=?", id);
      const n = (await one(env, "SELECT COUNT(*) c FROM categories WHERE tg_id=? AND active=1", id)).c;
      return view(
        env, cb,
        (n ? "🔎 Мониторинг запущен." : "Мониторинг включён, но категорий пока нет. Добавь первую.") +
          `\nАктивных категорий: ${n}`,
        mainMenu()
      );
    }

    case "menu:pause":
      await run(env, "UPDATE users SET paused=1 WHERE tg_id=?", id);
      return view(env, cb, "⏸ Мониторинг приостановлен. Нажми «Начать мониторинг», чтобы продолжить.", mainMenu());

    case "menu:add":
      await setState(env, id, "waiting_url");
      return view(
        env, cb,
        "Отправь ссылку на категорию или поиск Kufar, например:\n<code>https://www.kufar.by/l/minsk/mobilnye-telefony</code>",
        kb([backRow])
      );

    case "menu:cats": {
      await setState(env, id, null);
      const rows = await all(env, "SELECT * FROM categories WHERE tg_id=?", id);
      const list = rows.map((x) => [B(`${x.active ? "🟢" : "⚪️"} ${x.title}`, `cat:${x.id}`)]);
      return view(
        env, cb,
        rows.length ? "📂 Твои категории:" : "Категорий пока нет. Нажми «Добавить категорию».",
        kb([...list, backRow])
      );
    }

    case "cat": {
      await setState(env, id, null);
      const cat = await getCat(env, Number(b), id);
      if (!cat) return alert("Категория не найдена");
      return view(env, cb, catText(cat), catKb(cat));
    }

    case "toggle": {
      const cat = await getCat(env, Number(b), id);
      if (!cat) return alert("Категория не найдена");
      await run(env, "UPDATE categories SET active=? WHERE id=?", cat.active ? 0 : 1, cat.id);
      const upd = await getCat(env, cat.id, id);
      return view(env, cb, catText(upd), catKb(upd));
    }

    case "del": {
      const cat = await getCat(env, Number(b), id);
      if (cat) {
        await env.DB.batch([
          prep(env, "DELETE FROM categories WHERE id=?", cat.id),
          prep(env, "DELETE FROM seen WHERE category_id=?", cat.id),
        ]);
      }
      const rows = await all(env, "SELECT * FROM categories WHERE tg_id=?", id);
      const list = rows.map((x) => [B(`${x.active ? "🟢" : "⚪️"} ${x.title}`, `cat:${x.id}`)]);
      return view(env, cb, rows.length ? "🗑 Удалено. Твои категории:" : "🗑 Удалено. Категорий больше нет.", kb([...list, backRow]));
    }

    case "edit": {
      if (!(c in FIELDS) || !(await getCat(env, Number(b), id))) return alert("Категория не найдена");
      await setState(env, id, "waiting_value", { cat_id: Number(b), field: c });
      const [label, hint] = FIELDS[c];
      return view(
        env, cb,
        `<b>${label}</b>\nФормат: ${hint}.` + (c === "interval" ? "" : "\nОтправь «-», чтобы сбросить."),
        kb([[B("Отмена", `cat:${b}`)]])
      );
    }

    case "menu:settings": {
      const row = ["1", "5", "10", "30"].map((m) => B(`${user.interval === Number(m) ? "✅ " : ""}${m} мин`, `definterval:${m}`));
      return view(
        env, cb,
        `⚙️ <b>Настройки</b>\nМониторинг: ${user.paused ? "⏸ приостановлен" : "🟢 работает"}\n\nИнтервал проверки по умолчанию для новых категорий:`,
        kb([row, backRow])
      );
    }

    case "definterval": {
      const n = Number(b);
      if ([1, 5, 10, 30].includes(n)) await run(env, "UPDATE users SET interval=? WHERE tg_id=?", n, id);
      const row = ["1", "5", "10", "30"].map((m) => B(`${n === Number(m) ? "✅ " : ""}${m} мин`, `definterval:${m}`));
      return view(
        env, cb,
        `⚙️ <b>Настройки</b>\nМониторинг: ${user.paused ? "⏸ приостановлен" : "🟢 работает"}\n\nИнтервал проверки по умолчанию для новых категорий:`,
        kb([row, backRow])
      );
    }

    case "menu:history": {
      const rows = await all(env, "SELECT * FROM history WHERE tg_id=? ORDER BY id DESC LIMIT 10", id);
      const text = rows.length
        ? "📋 <b>Последние объявления:</b>\n\n" +
          rows.map((r) => `• <a href="${esc(r.url)}">${esc(r.title)}</a> — ${esc(r.price)} (${fmtDate(r.ts * 1000, false)})`).join("\n")
        : "История пока пуста.";
      return view(env, cb, text, kb([backRow]));
    }

    default:
      return tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  }
}

// ───────────────────────── Мониторинг (cron) ─────────────────────────

async function checkCategory(env, cat) {
  const now = Math.floor(Date.now() / 1000);
  await run(env, "UPDATE categories SET last_check=? WHERE id=?", now, cat.id);

  let ads;
  try {
    ads = await fetchAds(cat.url);
  } catch (e) {
    console.log("fetch failed", cat.id, e.message);
    return;
  }
  const seenRows = await all(env, "SELECT ad_id FROM seen WHERE category_id=?", cat.id);
  const seen = new Set(seenRows.map((r) => r.ad_id));
  const fresh = ads.filter((a) => !seen.has(a.id));
  if (!fresh.length) return;

  await env.DB.batch(fresh.map((a) => prep(env, "INSERT OR IGNORE INTO seen VALUES(?,?)", cat.id, a.id)));

  const toSend = fresh.slice(0, MAX_SENDS).reverse().filter((a) => passes(a, cat));
  const hist = [];
  for (const ad of toSend) {
    if (await sendAd(env, cat.tg_id, ad)) {
      hist.push(prep(env, "INSERT INTO history(tg_id,ad_id,title,price,url,ts) VALUES(?,?,?,?,?,?)",
        cat.tg_id, ad.id, ad.title, priceStr(ad), ad.url, now));
    }
  }
  const tail = [
    // чистим старое, чтобы база не росла
    prep(env, "DELETE FROM seen WHERE category_id=? AND rowid NOT IN (SELECT rowid FROM seen WHERE category_id=? ORDER BY rowid DESC LIMIT 500)", cat.id, cat.id),
    prep(env, "DELETE FROM history WHERE tg_id=? AND id NOT IN (SELECT id FROM history WHERE tg_id=? ORDER BY id DESC LIMIT 50)", cat.tg_id, cat.tg_id),
  ];
  await env.DB.batch([...hist, ...tail]);
}

async function runMonitor(env) {
  await ensureSchema(env);
  const now = Math.floor(Date.now() / 1000);
  const cats = await all(
    env,
    `SELECT c.* FROM categories c JOIN users u ON u.tg_id=c.tg_id
     WHERE c.active=1 AND u.paused=0 AND c.last_check + c.interval*60 <= ?
     ORDER BY c.last_check ASC LIMIT ?`,
    now, MAX_CATS_PER_RUN
  );
  for (const cat of cats) {
    try {
      await checkCategory(env, cat);
    } catch (e) {
      console.log("check error", cat.id, e.message);
    }
  }
}

// ───────────────────────── Точки входа ─────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(
        (async () => {
          try {
            await ensureSchema(env);
            if (update.message) await onMessage(env, update.message);
            else if (update.callback_query) await onCallback(env, update.callback_query);
          } catch (e) {
            console.log("update error", e.message, e.stack);
          }
        })()
      );
      return new Response("ok");
    }

    const authorized = env.WEBHOOK_SECRET && url.searchParams.get("key") === env.WEBHOOK_SECRET;

    // Открой в браузере: https://<воркер>.workers.dev/setup?key=<WEBHOOK_SECRET>
    if (url.pathname === "/setup") {
      if (!authorized) return new Response("Нужен ?key=<WEBHOOK_SECRET>", { status: 403 });
      const j = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });
      await tg(env, "setMyCommands", { commands: [{ command: "start", description: "Главное меню" }] });
      return new Response(j.ok ? "✅ Webhook установлен. Напиши боту /start" : "❌ " + JSON.stringify(j), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // Проверка, что Kufar отдаёт данные воркеру: /test?key=...&url=https://www.kufar.by/l/...
    if (url.pathname === "/test") {
      if (!authorized) return new Response("Нужен ?key=<WEBHOOK_SECRET>", { status: 403 });
      const target = url.searchParams.get("url");
      if (!validKufarUrl(target || "")) return new Response("Нужен параметр url=ссылка Kufar", { status: 400 });
      try {
        const ads = await fetchAds(target);
        return Response.json({ ok: true, count: ads.length, first: ads.slice(0, 3).map((a) => ({ title: a.title, price: a.price, city: a.city })) });
      } catch (e) {
        return Response.json({ ok: false, error: e.message });
      }
    }

    return new Response("Kufar bot работает");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonitor(env));
  },
};
