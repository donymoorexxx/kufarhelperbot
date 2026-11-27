// API для Telegram Mini App + каталог категорий. Авторизация — по подписанному initData от Telegram.

import { HttpError, handleAdmin, getSetting, aiAvailable, aiSelfTest, logEvent, limitsFor, usageFor, redeemPromo, getTiers, HARD_MAX_CATEGORIES } from "./core.js";
import {
  passes, rowToAd, scoreAd, analogsFor, sigOf, dsigOf, median, mean, jaccard, toCsv, parseFilter, tokens, phraseMatch,
} from "./logic.js";

// ───────── Каталог категорий и регионов ─────────
// path — часть адреса kufar.by/l/<регион>/<path>. Проверка адресов: /api/diag?key=<WEBHOOK_SECRET>
const CATEGORIES = [
  { id: "phones", name: "Мобильные телефоны", icon: "📱", group: "Электроника", path: "mobilnye-telefony" },
  { id: "phonetab", name: "Телефоны и планшеты (всё)", icon: "📞", group: "Электроника", path: "telefony-i-planshety" },
  { id: "laptops", name: "Ноутбуки", icon: "💻", group: "Электроника", path: "noutbuki" },
  { id: "tablets", name: "Планшеты", icon: "📲", group: "Электроника", path: "planshety" },
  { id: "computers", name: "Компьютерная техника", icon: "🖥️", group: "Электроника", path: "kompyuternaya-tehnika" },
  { id: "tv", name: "Телевизоры", icon: "📺", group: "Электроника", path: "televizory" },
  { id: "games", name: "Игры и приставки", icon: "🎮", group: "Электроника", path: "igry-i-pristavki" },
  { id: "electronics", name: "Электроника (всё)", icon: "🔌", group: "Электроника", path: "elektronika" },
  { id: "appliances", name: "Бытовая техника", icon: "🧺", group: "Электроника", path: "bytovaya-tehnika" },
  { id: "women", name: "Женский гардероб", icon: "👗", group: "Одежда и красота", path: "zhenskij-garderob" },
  { id: "men", name: "Мужской гардероб", icon: "👕", group: "Одежда и красота", path: "muzhskoj-garderob" },
  { id: "beauty", name: "Красота и здоровье", icon: "💄", group: "Одежда и красота", path: "krasota-i-zdorovie" },
  { id: "kids", name: "Всё для детей и мам", icon: "🧸", group: "Одежда и красота", path: "vse-dlya-detej-i-mam" },
  { id: "furniture", name: "Мебель", icon: "🛋️", group: "Дом и сад", path: "mebel" },
  { id: "home", name: "Всё для дома", icon: "🏡", group: "Дом и сад", path: "vse-dlya-doma" },
  { id: "repair", name: "Ремонт и стройка", icon: "🧱", group: "Дом и сад", path: "remont-i-strojka" },
  { id: "garden", name: "Сад и огород", icon: "🌱", group: "Дом и сад", path: "sad-i-ogorod" },
  { id: "hobby", name: "Хобби, спорт и туризм", icon: "⚽", group: "Хобби и другое", path: "hobbi-sport-i-turizm" },
  { id: "wedding", name: "Свадьба и праздники", icon: "🎉", group: "Хобби и другое", path: "svadba-i-prazdniki" },
  { id: "pets", name: "Животные", icon: "🐶", group: "Хобби и другое", path: "zhivotnye" },
  { id: "business", name: "Готовый бизнес и оборудование", icon: "🏭", group: "Хобби и другое", path: "gotovyj-biznes-i-oborudovanie" },
  { id: "jobs", name: "Работа", icon: "💼", group: "Хобби и другое", path: "rabota-biznes-uchjoba" },
  { id: "services", name: "Услуги", icon: "🛠️", group: "Хобби и другое", path: "uslugi" },
  { id: "other", name: "Прочее", icon: "📦", group: "Хобби и другое", path: "prochee" },
];
// Авто и недвижимость живут на отдельных сайтах Kufar (auto.kufar.by, re.kufar.by), здесь их нет.

const REGIONS = [
  { id: "all", name: "Вся Беларусь", path: "" },
  { id: "minsk", name: "Минск", path: "r~minsk" },
  { id: "minskobl", name: "Минская обл.", path: "r~minskaya-obl" },
  { id: "brest", name: "Брест", path: "r~brest" },
  { id: "brestobl", name: "Брестская обл.", path: "r~brestskaya-obl" },
  { id: "vitebsk", name: "Витебск", path: "r~vitebsk" },
  { id: "vitebskobl", name: "Витебская обл.", path: "r~vitebskaya-obl" },
  { id: "gomel", name: "Гомель", path: "r~gomel" },
  { id: "gomelobl", name: "Гомельская обл.", path: "r~gomelskaya-obl" },
  { id: "grodno", name: "Гродно", path: "r~grodno" },
  { id: "grodnoobl", name: "Гродненская обл.", path: "r~grodnenskaya-obl" },
  { id: "mogilev", name: "Могилёв", path: "r~mogilev" },
  { id: "mogilevobl", name: "Могилёвская обл.", path: "r~mogilevskaya-obl" },
];

const buildUrl = (cat, region) => `https://www.kufar.by/l/${region.path ? region.path + "/" : ""}${cat.path}`;

const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// ───────── Проверка подписи Telegram initData ─────────
async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function verifyInitData(initData, botToken) {
  if (!initData) throw new HttpError("Открой приложение через Telegram", 401);
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new HttpError("Нет подписи", 401);
  params.delete("hash");
  const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  if (hex(await hmac(secret, dataCheck)) !== hash) throw new HttpError("Неверная подпись", 401);
  if (Date.now() / 1000 - Number(params.get("auth_date") || 0) > 86400) throw new HttpError("Сессия устарела, закрой и открой приложение заново", 401);
  const user = JSON.parse(params.get("user") || "null");
  if (!user?.id) throw new HttpError("Нет пользователя", 401);
  return user;
}

// ───────── Проверка полей ─────────
function num(v) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(",", "."));
  if (!Number.isFinite(n) || n < 0) throw new HttpError("Цена должна быть числом");
  return n;
}

function cleanFields(f = {}) {
  const out = {};
  for (const k of ["min_price", "max_price"]) if (k in f) out[k] = num(f[k]);
  for (const k of ["city", "keywords", "exclude"]) if (k in f) out[k] = String(f[k] ?? "").trim().slice(0, 200) || null;
  if ("profile" in f) out.profile = String(f.profile ?? "").trim().slice(0, 30) || null;
  if ("condition" in f) out.condition = f.condition === "new" || f.condition === "used" ? f.condition : null;
  if ("interval" in f) {
    const n = Math.floor(Number(f.interval));
    if (!(n >= 1 && n <= 1440)) throw new HttpError("Интервал: от 1 до 1440 минут");
    out.interval = n;
  }
  if (out.min_price != null && out.max_price != null && out.min_price > out.max_price) throw new HttpError("Мин. цена больше максимальной");
  return out;
}

const marketOf = (c) => c.market || c.cat_key || `c${c.id}`;
const stdev = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

export async function handleApi(request, env, url, H) {
  const { prep, all, one, run, tg, fetchAds, ensureUser, batchChunks, analyzeAd, aiText } = H;
  try {
    const path = url.pathname;
    const key = url.searchParams.get("key");
    const isOwner = env.WEBHOOK_SECRET && key === env.WEBHOOK_SECRET;

    if (path === "/api/catalog") return json({ categories: CATEGORIES, regions: REGIONS, tiers: [...(await getTiers(env)).values()].map((t) => ({ id: t.id, name: t.name, limits: t.limits })) });

    // Проверка адресов каталога по очереди (Kufar отвечает 429 на частые запросы): /api/diag?key=...
    if (path === "/api/diag") {
      if (!isOwner) throw new HttpError("forbidden", 403);
      const check = async (u) => {
        for (let i = 0; i < 2; i++) {
          try {
            const r = await fetch(u, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "ru-RU" } });
            r.body?.cancel();
            if (r.status !== 429) return r.status;
          } catch (e) { return String(e.message); }
          await sleep(1500);
        }
        return 429;
      };
      const lines = ["КАТЕГОРИИ (200 = работает, 404 = неверный адрес, 429 = Kufar просит подождать):"];
      for (const c of CATEGORIES) { lines.push(`${await check(buildUrl(c, REGIONS[0]))}  ${c.name}  (${c.path})`); await sleep(500); }
      lines.push("", "РЕГИОНЫ:");
      for (const r of REGIONS.slice(1)) { lines.push(`${await check(buildUrl(CATEGORIES[0], r))}  ${r.name}  (${r.path})`); await sleep(500); }
      return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    // Проверка нейросетей: показывает реальную ошибку каждого провайдера и модели: /api/aitest?key=...
    if (path === "/api/aitest") {
      if (!isOwner) throw new HttpError("forbidden", 403);
      return new Response(await aiSelfTest(env), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (path === "/api/discover") {
      if (!isOwner) throw new HttpError("forbidden", 403);
      const target = url.searchParams.get("url") || "https://www.kufar.by/";
      if (!/^https:\/\/(www\.)?kufar\.by\//.test(target)) throw new HttpError("Нужен адрес kufar.by");
      const r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "ru-RU" } });
      const html = await r.text();
      const found = new Map();
      const re = /<a[^>]+href="(?:https:\/\/www\.kufar\.by)?(\/l\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) && found.size < 300) {
        const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
        if (!found.has(m[1])) found.set(m[1], text);
      }
      const lines = [...found].map(([p, t]) => `${p}  —  ${t}`);
      return new Response(`HTTP ${r.status}, ссылок /l/: ${lines.length}\n\n${lines.join("\n")}`, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    // ───── всё остальное: только из Telegram ─────
    const tgUser = await verifyInitData(request.headers.get("X-Init-Data"), env.BOT_TOKEN);
    const uid = tgUser.id;
    const now = Math.floor(Date.now() / 1000);
    const owner = !!env.OWNER_TELEGRAM_ID && String(uid) === String(env.OWNER_TELEGRAM_ID); // проверка прав только на сервере
    const user = await ensureUser(env, uid, tgUser);
    if (user.blocked && !owner) throw new HttpError("Доступ ограничен администратором", 403);
    if (!owner && (await getSetting(env, "maintenance", "0")) === "1") throw new HttpError("Идут технические работы. Мониторинг продолжает работать, приложение скоро вернётся.", 503);
    const T = await limitsFor(env, user); // действующий тариф: проверки лимитов только здесь, на сервере
    const lock = (flag, what) => { if (!T.limits[flag]) throw new HttpError(`«${what}» недоступно на тарифе ${T.name}. Открой на более высоком тарифе или по промокоду.`, 403); };
    if (!user.last_seen || now - user.last_seen > 3600) await logEvent(env, "login", uid, tgUser.username ? "@" + tgUser.username : tgUser.first_name || "");
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const q = url.searchParams;

    if (path.startsWith("/api/admin/")) {
      if (!owner) {
        await logEvent(env, "security", uid, `попытка доступа к админке: ${path}`);
        throw new HttpError("Нет доступа", 403);
      }
      return json(await handleAdmin(env, uid, path, request.method, q, body));
    }

    // Объявления пользователя (видны ему по его категориям) с фильтрами категории
    const userAds = async (limit = 300) => {
      const rows = await all(env,
        `SELECT a.*, c.min_price AS f_min, c.max_price AS f_max, c.city AS f_city, c.keywords AS f_kw, c.exclude AS f_ex, c.condition AS f_cond, f.ad_id AS fav
         FROM ads a
         JOIN (SELECT ad_id, MIN(category_id) AS category_id FROM seen WHERE category_id IN (SELECT id FROM categories WHERE tg_id=?) GROUP BY ad_id) s ON s.ad_id=a.ad_id
         JOIN categories c ON c.id=s.category_id
         LEFT JOIN favs f ON f.ad_id=a.ad_id AND f.tg_id=?
         WHERE a.first_seen >= ?
         ORDER BY a.first_seen DESC LIMIT ?`, uid, uid, now - T.limits.history_days * 86400, limit); // глубина истории по тарифу
      return rows.filter((r) => passes(rowToAd(r), { min_price: r.f_min, max_price: r.f_max, city: r.f_city, keywords: r.f_kw, exclude: r.f_ex, condition: r.f_cond }, user));
    };

    if (path === "/api/state") {
      const [categories, f24, favs] = await Promise.all([
        all(env, "SELECT id,title,cat_key,market,profile,condition,active,min_price,max_price,city,keywords,exclude,interval,since FROM categories WHERE tg_id=? ORDER BY id DESC", uid),
        one(env, "SELECT COUNT(*) c FROM history WHERE tg_id=? AND ts>=?", uid, now - 86400),
        one(env, "SELECT COUNT(*) c FROM favs WHERE tg_id=?", uid),
      ]);
      return json({
        user: {
          paused: !!user.paused, interval: user.interval, name: tgUser.first_name || "", quiet: !!user.quiet, report: user.report || "off",
          forward_chat: user.forward_chat || null, bl_words: user.bl_words || "", bl_sellers: user.bl_sellers || "", ai: await aiAvailable(env), owner,
        },
        categories,
        stats: { found24: f24.c, favs: favs.c, active: categories.filter((c) => c.active).length },
        tier: { id: T.id, name: T.name, until: T.until, unlimited: T.unlimited, limits: T.limits, usage: await usageFor(env, user) },
      });
    }

    if (path === "/api/subscribe") {
      const cat = CATEGORIES.find((c) => c.id === body.category);
      const region = REGIONS.find((r) => r.id === (body.region || "all"));
      if (!cat || !region) throw new HttpError("Категория не найдена");
      const usage = await usageFor(env, user);
      if (usage.categories >= Math.min(T.limits.max_categories, HARD_MAX_CATEGORIES)) throw new HttpError(`Лимит категорий на тарифе ${T.name}: ${T.limits.max_categories}. Удали лишнюю или повысь тариф.`, 403);
      const fields = cleanFields({ interval: user.interval, ...(body.filters || {}) });
      if (usage.profiles >= T.limits.max_profiles && !(await one(env, "SELECT 1 x FROM categories WHERE tg_id=? AND COALESCE(profile,'')=?", uid, fields.profile ?? ""))) {
        throw new HttpError(`Лимит профилей поиска на тарифе ${T.name}: ${T.limits.max_profiles}.`, 403);
      }
      let adjusted = null;
      if (fields.interval < T.limits.min_interval) { fields.interval = T.limits.min_interval; adjusted = fields.interval; }
      const onlyNew = body.only_new !== false;
      const catUrl = buildUrl(cat, region);
      let ads;
      try {
        ads = await fetchAds(catUrl);
      } catch (e) {
        const gone = /404/.test(e.message);
        const busy = /429/.test(e.message);
        throw new HttpError(
          gone ? "Kufar не нашёл такую страницу: адрес категории или региона изменился. Выбери другую."
            : busy ? "Kufar просит подождать (слишком много запросов). Попробуй через минуту."
            : `Не удалось открыть категорию на Kufar: ${e.message}`, 502);
      }
      const market = `${cat.id}:${region.id}`;
      const title = region.id === "all" ? cat.name : `${cat.name} · ${region.name}`;
      const res = await run(env,
        "INSERT INTO categories(tg_id,url,title,cat_key,market,profile,condition,min_price,max_price,city,keywords,exclude,interval,since) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        uid, catUrl, title, cat.id, market, fields.profile ?? null, fields.condition ?? null, fields.min_price ?? null, fields.max_price ?? null,
        fields.city ?? null, fields.keywords ?? null, fields.exclude ?? null, fields.interval, onlyNew ? now : null);
      const id = res.meta.last_row_id;

      // Сохраняем текущие объявления страницы: это начало реальной базы для аналитики и сравнения цен
      const pool = ads.map((a) => ({ ad_id: a.id, title: a.title, price: a.price, sig: sigOf(a.title) }));
      const stmts = [];
      for (const a of ads) {
        const sc = scoreAd(a, analogsFor(a, pool));
        stmts.push(prep(env,
          "INSERT OR IGNORE INTO ads(ad_id,market,title,price,city,url,photo,descr,seller,cond,photos,params,list_time,first_seen,sig,dsig,score,dev,dup_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          a.id, market, a.title, a.price, a.city, a.url, a.photo, a.desc, a.seller, a.cond, a.photos, a.params, a.date, now, sigOf(a.title), dsigOf(a.desc), sc.score, sc.dev, null));
        if (a.price != null) stmts.push(prep(env, "INSERT INTO price_hist(ad_id,price,ts) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM price_hist WHERE ad_id=?)", a.id, a.price, now, a.id));
        // «только новые»: всё, что уже есть на странице, считаем просмотренным
        if (onlyNew) stmts.push(prep(env, "INSERT OR IGNORE INTO seen VALUES(?,?)", id, a.id));
      }
      await batchChunks(env, stmts);
      return json({ ok: true, id, existing: ads.length, interval_adjusted: adjusted });
    }

    if (path === "/api/update") {
      const owned = await one(env, "SELECT id FROM categories WHERE id=? AND tg_id=?", body.id, uid);
      if (!owned) throw new HttpError("Категория не найдена", 404);
      const fields = cleanFields(body.fields || {});
      let adjusted = null;
      if (fields.interval < T.limits.min_interval) { fields.interval = T.limits.min_interval; adjusted = fields.interval; }
      if ("profile" in fields) {
        const others = await one(env, "SELECT COUNT(DISTINCT COALESCE(profile,'')) c FROM categories WHERE tg_id=? AND id!=?", uid, body.id);
        const same = await one(env, "SELECT 1 x FROM categories WHERE tg_id=? AND id!=? AND COALESCE(profile,'')=?", uid, body.id, fields.profile ?? "");
        if (others.c + (same ? 0 : 1) > T.limits.max_profiles) throw new HttpError(`Лимит профилей поиска на тарифе ${T.name}: ${T.limits.max_profiles}.`, 403);
      }
      const keys = Object.keys(fields);
      if (keys.length) await run(env, `UPDATE categories SET ${keys.map((k) => k + "=?").join(",")} WHERE id=? AND tg_id=?`, ...keys.map((k) => fields[k]), body.id, uid);
      return json({ ok: true, interval_adjusted: adjusted });
    }

    // Массовое изменение фильтров у выбранных категорий
    if (path === "/api/bulk") {
      const idsIn = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isInteger).slice(0, HARD_MAX_CATEGORIES);
      if (!idsIn.length) throw new HttpError("Не выбрано ни одной категории");
      const fields = cleanFields(body.fields || {});
      delete fields.profile; // профили меняются по одному, с проверкой лимита
      if (fields.interval < T.limits.min_interval) fields.interval = T.limits.min_interval;
      const keys = Object.keys(fields);
      if (!keys.length) throw new HttpError("Нечего менять");
      await env.DB.batch(idsIn.map((id) => prep(env, `UPDATE categories SET ${keys.map((k) => k + "=?").join(",")} WHERE id=? AND tg_id=?`, ...keys.map((k) => fields[k]), id, uid)));
      return json({ ok: true, changed: idsIn.length });
    }

    if (path === "/api/toggle") {
      const cur = await one(env, "SELECT active FROM categories WHERE id=? AND tg_id=?", body.id, uid);
      if (!cur) throw new HttpError("Категория не найдена", 404);
      if (cur.active) await run(env, "UPDATE categories SET active=0 WHERE id=? AND tg_id=?", body.id, uid);
      else await run(env, "UPDATE categories SET active=1, since=?, last_check=0 WHERE id=? AND tg_id=?", body.skip_old ? now : null, body.id, uid);
      return json({ ok: true });
    }

    if (path === "/api/delete") {
      const owned = await one(env, "SELECT id FROM categories WHERE id=? AND tg_id=?", body.id, uid);
      if (owned) await env.DB.batch([prep(env, "DELETE FROM categories WHERE id=?", owned.id), prep(env, "DELETE FROM seen WHERE category_id=?", owned.id)]);
      return json({ ok: true });
    }

    if (path === "/api/settings") {
      if ("paused" in body) {
        await run(env, "UPDATE users SET paused=? WHERE tg_id=?", body.paused ? 1 : 0, uid);
        if (!body.paused) await run(env, "UPDATE categories SET since=?, last_check=0 WHERE tg_id=? AND active=1", body.skip_old ? now : null, uid);
      }
      if ("interval" in body) await run(env, "UPDATE users SET interval=? WHERE tg_id=?", Math.max(cleanFields({ interval: body.interval }).interval, T.limits.min_interval), uid);
      if ("quiet" in body) await run(env, "UPDATE users SET quiet=? WHERE tg_id=?", body.quiet ? 1 : 0, uid);
      if ("report" in body) {
        if (!["off", "daily", "weekly"].includes(body.report)) throw new HttpError("Неверный период отчёта");
        if (body.report !== "off") lock("reports", "Отчёты в чат");
        await run(env, "UPDATE users SET report=? WHERE tg_id=?", body.report, uid);
      }
      if ("forward_chat" in body) {
        const v = body.forward_chat === "" || body.forward_chat == null ? null : Number(body.forward_chat);
        if (v !== null && !Number.isSafeInteger(v)) throw new HttpError("ID чата должен быть числом");
        if (v !== null) lock("forward", "Пересылка в другой чат");
        await run(env, "UPDATE users SET forward_chat=? WHERE tg_id=?", v, uid);
      }
      if ("bl_words" in body) await run(env, "UPDATE users SET bl_words=? WHERE tg_id=?", String(body.bl_words || "").slice(0, 500) || null, uid);
      if ("bl_sellers" in body) await run(env, "UPDATE users SET bl_sellers=? WHERE tg_id=?", String(body.bl_sellers || "").replace(/[^\d,]/g, "").slice(0, 500) || null, uid);
      return json({ ok: true });
    }

    // Лента: «Лучшие находки» и «Все объявления»
    if (path === "/api/feed") {
      const mode = q.get("mode") === "all" ? "all" : "best";
      const sort = ["date", "price", "score", "dev"].includes(q.get("sort")) ? q.get("sort") : mode === "best" ? "score" : "date";
      const limit = Math.min(Number(q.get("limit")) || 60, 100);
      let rows = await userAds(300);
      const drops = new Map(
        (await all(env, "SELECT ad_id, MAX(price) mx, COUNT(*) n FROM price_hist WHERE ts>=? GROUP BY ad_id HAVING n>1", now - 3 * 86400)).map((r) => [r.ad_id, r.mx]));
      const text = (q.get("q") || "").trim();
      if (text) {
        rows = rows.filter((r) => { const tt = tokens(r.title); return text.split(",").some((p) => phraseMatch(tt, p)); });
      }
      const items = rows.map((r) => ({
        id: r.ad_id, title: r.title, price: r.price, city: r.city, url: r.url, photo: r.photo, score: r.score, dev: r.dev,
        first_seen: r.first_seen, list_time: r.list_time, seller: r.seller, fav: !!r.fav, photos: r.photos,
        drop: drops.has(r.ad_id) && r.price != null && r.price < drops.get(r.ad_id) * 0.97,
      }));
      let list = items;
      if (mode === "best") {
        // сомнительные предложения в топ не попадают: нужна оценка, фото и цена не «слишком хороша»
        list = items.filter((i) => (i.score != null && i.score >= 60 && i.photos > 0 && !(i.dev != null && i.dev < -0.6)) || i.drop);
      }
      const by = {
        date: (a, b) => b.first_seen - a.first_seen,
        price: (a, b) => (a.price ?? 1e12) - (b.price ?? 1e12),
        score: (a, b) => (b.score ?? -1) - (a.score ?? -1),
        dev: (a, b) => (a.dev ?? 9) - (b.dev ?? 9),
      }[sort];
      return json({ items: list.sort(by).slice(0, limit), total: list.length });
    }

    // Подробности объявления: оценка, аналоги, история цены, продавец
    if (path === "/api/ad") {
      const row = await one(env, "SELECT * FROM ads WHERE ad_id=?", String(q.get("id") || ""));
      if (!row) throw new HttpError("Объявление не найдено", 404);
      const ad = rowToAd(row);
      const pool = await all(env, "SELECT ad_id,title,price,sig FROM ads WHERE market=? ORDER BY first_seen DESC LIMIT 600", row.market);
      const analogs = analogsFor(ad, pool);
      const sc = scoreAd(ad, analogs);
      const A = new Set(sigOf(ad.title).split(" "));
      const nearest = analogs
        .map((r) => ({ ...r, j: jaccard(A, new Set(String(r.sig).split(" "))) }))
        .sort((a, b) => b.j - a.j || Math.abs(a.price - ad.price) - Math.abs(b.price - ad.price))
        .slice(0, 5);
      const nearUrls = nearest.length ? await all(env, `SELECT ad_id,url FROM ads WHERE ad_id IN (${nearest.map(() => "?").join(",")})`, ...nearest.map((n) => n.ad_id)) : [];
      const urlOf = new Map(nearUrls.map((r) => [r.ad_id, r.url]));
      const [history, seller, fav] = await Promise.all([
        all(env, "SELECT price, ts FROM price_hist WHERE ad_id=? ORDER BY ts", row.ad_id),
        row.seller
          ? all(env, "SELECT ad_id,title,price,url,first_seen FROM ads WHERE seller=? ORDER BY first_seen DESC LIMIT 8", row.seller)
          : Promise.resolve([]),
        one(env, "SELECT note, price0, added FROM favs WHERE tg_id=? AND ad_id=?", uid, row.ad_id),
      ]);
      return json({
        ad: { ...ad, first_seen: row.first_seen, score: row.score, dup_of: row.dup_of },
        score: sc,
        analogs: { n: analogs.length, nearest: nearest.map((n) => ({ title: n.title, price: n.price, url: urlOf.get(n.ad_id) })) },
        history, seller: row.seller ? { id: row.seller, ads: seller } : null, fav,
      });
    }

    if (path === "/api/promo") {
      const r = await redeemPromo(env, uid, body.code);
      return json({ ok: true, ...r });
    }

    if (path === "/api/fav") {
      const row = await one(env, "SELECT ad_id, price FROM ads WHERE ad_id=?", String(body.id || ""));
      if (!row) throw new HttpError("Объявление не найдено", 404);
      await run(env, "INSERT OR IGNORE INTO favs(tg_id,ad_id,added,price0) VALUES(?,?,?,?)", uid, row.ad_id, now, row.price);
      if ("note" in body) await run(env, "UPDATE favs SET note=? WHERE tg_id=? AND ad_id=?", String(body.note || "").slice(0, 300) || null, uid, row.ad_id);
      return json({ ok: true });
    }
    if (path === "/api/unfav") {
      await run(env, "DELETE FROM favs WHERE tg_id=? AND ad_id=?", uid, String(body.id || ""));
      return json({ ok: true });
    }
    if (path === "/api/favs") {
      const rows = await all(env,
        "SELECT a.ad_id AS id, a.title, a.price, a.url, a.photo, a.city, a.score, f.price0, f.note, f.added, f.gone FROM favs f JOIN ads a ON a.ad_id=f.ad_id WHERE f.tg_id=? ORDER BY f.added DESC LIMIT 100", uid);
      return json({ items: rows });
    }

    // Аналитика только по реально собранным данным
    if (path === "/api/analytics") {
      lock("analytics", "Аналитика");
      const days = [7, 30, 90].includes(Number(q.get("days"))) ? Number(q.get("days")) : 30;
      const since = now - days * 86400;
      const cats = await all(env, "SELECT id, title, cat_key, market FROM categories WHERE tg_id=?", uid);
      const markets = new Map();
      for (const c of cats) if (!markets.has(marketOf(c))) markets.set(marketOf(c), c.title);
      const out = [];
      for (const [market, title] of [...markets].slice(0, 8)) {
        const [rows, prev, moves, first] = await Promise.all([
          all(env, "SELECT price, first_seen FROM ads WHERE market=? AND first_seen>=? LIMIT 3000", market, since),
          one(env, "SELECT AVG(price) a, COUNT(price) n FROM ads WHERE market=? AND price>0 AND first_seen>=? AND first_seen<?", market, since - days * 86400, since),
          all(env, "SELECT p.ad_id, p.price FROM price_hist p JOIN ads a ON a.ad_id=p.ad_id WHERE a.market=? AND p.ts>=? ORDER BY p.ad_id, p.ts LIMIT 5000", market, since),
          one(env, "SELECT MIN(first_seen) t FROM ads WHERE market=?", market),
        ]);
        const prices = rows.map((r) => r.price).filter((p) => p > 0);
        const byDay = new Map();
        for (const r of rows) {
          const d = new Date((r.first_seen + 3 * 3600) * 1000).toISOString().slice(0, 10);
          const e = byDay.get(d) || { d, n: 0, sum: 0, np: 0 };
          e.n++;
          if (r.price > 0) { e.sum += r.price; e.np++; }
          byDay.set(d, e);
        }
        const lastBy = new Map(), firstBy = new Map();
        for (const m of moves) { if (!firstBy.has(m.ad_id)) firstBy.set(m.ad_id, m.price); lastBy.set(m.ad_id, m.price); }
        let cheaper = 0, pricier = 0;
        for (const [id, f] of firstBy) { const l = lastBy.get(id); if (l < f) cheaper++; else if (l > f) pricier++; }
        const avg = mean(prices);
        out.push({
          market, title, n: rows.length, priced: prices.length,
          mean: avg, median: median(prices), min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null, std: stdev(prices),
          prevMean: prev.n >= 5 ? prev.a : null, change: prev.n >= 5 && avg != null ? (avg - prev.a) / prev.a : null,
          cheaper, pricier, since: first.t,
          series: [...byDay.values()].sort((a, b) => (a.d < b.d ? -1 : 1)).map((e) => ({ d: e.d, n: e.n, avg: e.np ? e.sum / e.np : null })),
        });
      }
      return json({ days, items: out });
    }

    // Экспорт в CSV: файл приходит в чат с ботом (Excel открывает такой файл)
    if (path === "/api/export") {
      lock("export", "Экспорт данных");
      const rows = await userAds(2000);
      if (!rows.length) throw new HttpError("Пока нечего экспортировать");
      const csv = toCsv(rows.map((r) => ({ ...r, found: new Date(r.first_seen * 1000).toISOString().slice(0, 16).replace("T", " ") })), [
        ["title", "Название"], ["price", "Цена BYN"], ["city", "Город"], ["found", "Обнаружено (UTC)"], ["score", "Оценка"], ["url", "Ссылка"], ["seller", "ID продавца"]]);
      const fd = new FormData();
      fd.append("chat_id", String(uid));
      fd.append("document", new Blob([csv], { type: "text/csv" }), "kufar_ads.csv");
      fd.append("caption", `Экспорт: ${rows.length} объявлений`);
      const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
      if (!r.ok) throw new HttpError("Не удалось отправить файл в чат", 502);
      return json({ ok: true, count: rows.length });
    }

    // AI: нужны секрет ANTHROPIC_API_KEY
    if (path === "/api/ai") {
      const row = await one(env, "SELECT * FROM ads WHERE ad_id=?", String(body.id || ""));
      if (!row) throw new HttpError("Объявление не найдено", 404);
      try {
        return json({ html: aiText(await analyzeAd(env, row, uid)) });
      } catch (e) { throw new HttpError(e.message, e.status || 503); }
    }

    if (path === "/api/nl") {
      const text = String(body.text || "").trim().slice(0, 500);
      if (!text) throw new HttpError("Напиши, что искать");
      let f;
      try { f = await parseFilter(env, text, CATEGORIES, REGIONS, uid); } catch (e) { throw new HttpError(e.message, e.status || 503); }
      const list = (a) => (Array.isArray(a) ? a.map(String).join(", ") : "");
      return json({
        category: CATEGORIES.find((c) => c.id === f.category)?.id || null,
        region: REGIONS.find((r) => r.id === f.region)?.id || "all",
        filters: {
          min_price: Number.isFinite(Number(f.min_price)) && f.min_price != null ? Number(f.min_price) : "",
          max_price: Number.isFinite(Number(f.max_price)) && f.max_price != null ? Number(f.max_price) : "",
          city: f.city ? String(f.city) : "", keywords: list(f.keywords), exclude: list(f.exclude),
          condition: f.condition === "new" || f.condition === "used" ? f.condition : null,
        },
        note: String(f.note || ""),
      });
    }

    throw new HttpError("Not found", 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.log("api error", e.message, e.stack);
    await logEvent(env, "api_error", null, `${new URL(request.url).pathname}: ${e.message}`);
    return json({ error: "Внутренняя ошибка" }, 500);
  }
}
