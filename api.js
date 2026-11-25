// API для Telegram Mini App + каталог категорий. Авторизация — по подписанному initData от Telegram.

// ───────── Каталог категорий и регионов ─────────
// Каталог категорий и регионов для Mini App.
// path — часть адреса kufar.by/l/<регион>/<path>. Если какая-то категория не открывается,
// достаточно поправить её path здесь. Проверка всех адресов: /api/diag?key=<WEBHOOK_SECRET>

const CATEGORIES = [
  { id: "phones", name: "Телефоны", icon: "📱", group: "Электроника", path: "telefony" },
  { id: "laptops", name: "Ноутбуки", icon: "💻", group: "Электроника", path: "noutbuki" },
  { id: "tablets", name: "Планшеты", icon: "📲", group: "Электроника", path: "planshety" },
  { id: "computers", name: "Компьютерная техника", icon: "🖥️", group: "Электроника", path: "kompyuternaya-tehnika" },
  { id: "tv", name: "Телевизоры", icon: "📺", group: "Электроника", path: "televizory" },
  { id: "games", name: "Игры и приставки", icon: "🎮", group: "Электроника", path: "igry-i-pristavki" },
  { id: "appliances", name: "Бытовая техника", icon: "🧺", group: "Электроника", path: "bytovaya-tehnika" },

  { id: "furniture", name: "Мебель", icon: "🛋️", group: "Дом", path: "mebel" },
  { id: "home", name: "Для дома и дачи", icon: "🏡", group: "Дом", path: "dlya-doma-i-dachi" },
  { id: "repair", name: "Ремонт и стройка", icon: "🧱", group: "Дом", path: "remont-i-stroitelstvo" },

  { id: "women", name: "Женская одежда", icon: "👗", group: "Одежда и обувь", path: "zhenskaya-odezhda" },
  { id: "men", name: "Мужская одежда", icon: "👕", group: "Одежда и обувь", path: "muzhskaya-odezhda" },
  { id: "shoes", name: "Обувь", icon: "👟", group: "Одежда и обувь", path: "obuv" },
  { id: "kids", name: "Товары для детей", icon: "🧸", group: "Одежда и обувь", path: "tovary-dlya-detej" },

  { id: "cars", name: "Автомобили", icon: "🚗", group: "Авто", path: "avtomobili" },
  { id: "parts", name: "Автозапчасти", icon: "🔧", group: "Авто", path: "avtozapchasti" },
  { id: "tires", name: "Шины и диски", icon: "🛞", group: "Авто", path: "shiny-i-diski" },
  { id: "moto", name: "Мототехника", icon: "🏍️", group: "Авто", path: "motocikly" },

  { id: "bikes", name: "Велосипеды", icon: "🚲", group: "Хобби и спорт", path: "velosipedy" },
  { id: "sport", name: "Спорт и отдых", icon: "⚽", group: "Хобби и спорт", path: "sport-i-otdyh" },
  { id: "music", name: "Музыкальные инструменты", icon: "🎸", group: "Хобби и спорт", path: "muzykalnye-instrumenty" },
  { id: "books", name: "Книги", icon: "📚", group: "Хобби и спорт", path: "knigi" },

  { id: "pets", name: "Животные", icon: "🐶", group: "Другое", path: "zhivotnye" },
  { id: "flats", name: "Квартиры", icon: "🏢", group: "Другое", path: "kvartiry" },
  { id: "jobs", name: "Работа", icon: "💼", group: "Другое", path: "rabota" },
  { id: "services", name: "Услуги", icon: "🛠️", group: "Другое", path: "uslugi" },
];

const REGIONS = [
  { id: "all", name: "Вся Беларусь", path: "" },
  { id: "minsk", name: "Минск", path: "r~minsk" },
  { id: "brest", name: "Брест", path: "r~brest" },
  { id: "vitebsk", name: "Витебск", path: "r~vitebsk" },
  { id: "gomel", name: "Гомель", path: "r~gomel" },
  { id: "grodno", name: "Гродно", path: "r~grodno" },
  { id: "mogilev", name: "Могилёв", path: "r~mogilev" },
];

function buildUrl(cat, region) {
  return `https://www.kufar.by/l/${region.path ? region.path + "/" : ""}${cat.path}`;
}

// ───────── API ─────────

const MAX_CATEGORIES_PER_USER = 20;
const enc = new TextEncoder();

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// Проверка подписи initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
async function verifyInitData(initData, botToken) {
  if (!initData) throw new HttpError("Открой приложение через Telegram", 401);
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new HttpError("Нет подписи", 401);
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  if (hex(await hmac(secret, dataCheck)) !== hash) throw new HttpError("Неверная подпись", 401);
  const age = Date.now() / 1000 - Number(params.get("auth_date") || 0);
  if (age > 86400) throw new HttpError("Сессия устарела, закрой и открой приложение заново", 401);
  const user = JSON.parse(params.get("user") || "null");
  if (!user?.id) throw new HttpError("Нет пользователя", 401);
  return user;
}

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
  if ("interval" in f) {
    const n = Math.floor(Number(f.interval));
    if (!(n >= 1 && n <= 1440)) throw new HttpError("Интервал: от 1 до 1440 минут");
    out.interval = n;
  }
  if (out.min_price != null && out.max_price != null && out.min_price > out.max_price) {
    throw new HttpError("Мин. цена больше максимальной");
  }
  return out;
}

export async function handleApi(request, env, url, H) {
  const { prep, all, one, run, fetchAds, ensureUser } = H;
  try {
    const path = url.pathname;

    if (path === "/api/catalog") return json({ categories: CATEGORIES, regions: REGIONS });

    // Диагностика адресов каталога: /api/diag?key=<WEBHOOK_SECRET>
    if (path === "/api/diag") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) throw new HttpError("forbidden", 403);
      const check = async (u) => {
        try {
          const r = await fetch(u, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "ru-RU" } });
          r.body?.cancel();
          return r.status;
        } catch (e) {
          return String(e.message);
        }
      };
      const base = CATEGORIES.find((c) => c.id === "phones");
      const [cats, regs] = await Promise.all([
        Promise.all(CATEGORIES.map(async (c) => `${await check(buildUrl(c, REGIONS[0]))}  ${c.name}  (${c.path})`)),
        Promise.all(REGIONS.slice(1).map(async (r) => `${await check(buildUrl(base, r))}  ${r.name}  (${r.path})`)),
      ]);
      return new Response(["КАТЕГОРИИ (200 = работает, 404 = неверный адрес):", ...cats, "", "РЕГИОНЫ:", ...regs].join("\n"), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // Всё остальное — только из Telegram
    const tgUser = await verifyInitData(request.headers.get("X-Init-Data"), env.BOT_TOKEN);
    const uid = tgUser.id;
    const user = await ensureUser(env, uid);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

    if (path === "/api/state") {
      const [categories, history] = await Promise.all([
        all(env, "SELECT id,title,cat_key,active,min_price,max_price,city,keywords,exclude,interval FROM categories WHERE tg_id=? ORDER BY id DESC", uid),
        all(env, "SELECT title,price,url,ts FROM history WHERE tg_id=? ORDER BY id DESC LIMIT 30", uid),
      ]);
      return json({ user: { paused: !!user.paused, interval: user.interval, name: tgUser.first_name || "" }, categories, history });
    }

    if (path === "/api/subscribe") {
      const cat = CATEGORIES.find((c) => c.id === body.category);
      const region = REGIONS.find((r) => r.id === (body.region || "all"));
      if (!cat || !region) throw new HttpError("Категория не найдена");
      const count = (await one(env, "SELECT COUNT(*) c FROM categories WHERE tg_id=?", uid)).c;
      if (count >= MAX_CATEGORIES_PER_USER) throw new HttpError(`Не больше ${MAX_CATEGORIES_PER_USER} категорий`);
      const fields = cleanFields({ interval: user.interval, ...(body.filters || {}) });
      const catUrl = buildUrl(cat, region);
      let ads;
      try {
        ads = await fetchAds(catUrl);
      } catch (e) {
        throw new HttpError(`Не удалось открыть категорию на Kufar: ${e.message}`, 502);
      }
      const title = region.id === "all" ? cat.name : `${cat.name} · ${region.name}`;
      const res = await run(
        env,
        "INSERT INTO categories(tg_id,url,title,cat_key,min_price,max_price,city,keywords,exclude,interval) VALUES(?,?,?,?,?,?,?,?,?,?)",
        uid, catUrl, title, cat.id,
        fields.min_price ?? null, fields.max_price ?? null, fields.city ?? null,
        fields.keywords ?? null, fields.exclude ?? null, fields.interval
      );
      const id = res.meta.last_row_id;
      if (ads.length) await env.DB.batch(ads.map((a) => prep(env, "INSERT OR IGNORE INTO seen VALUES(?,?)", id, a.id)));
      return json({ ok: true, id, existing: ads.length });
    }

    if (path === "/api/update") {
      const owned = await one(env, "SELECT id FROM categories WHERE id=? AND tg_id=?", body.id, uid);
      if (!owned) throw new HttpError("Категория не найдена", 404);
      const fields = cleanFields(body.fields || {});
      const keys = Object.keys(fields);
      if (keys.length) {
        await run(env, `UPDATE categories SET ${keys.map((k) => k + "=?").join(",")} WHERE id=? AND tg_id=?`, ...keys.map((k) => fields[k]), body.id, uid);
      }
      return json({ ok: true });
    }

    if (path === "/api/toggle") {
      await run(env, "UPDATE categories SET active=1-active WHERE id=? AND tg_id=?", body.id, uid);
      return json({ ok: true });
    }

    if (path === "/api/delete") {
      const owned = await one(env, "SELECT id FROM categories WHERE id=? AND tg_id=?", body.id, uid);
      if (owned) {
        await env.DB.batch([prep(env, "DELETE FROM categories WHERE id=?", owned.id), prep(env, "DELETE FROM seen WHERE category_id=?", owned.id)]);
      }
      return json({ ok: true });
    }

    if (path === "/api/settings") {
      if ("paused" in body) await run(env, "UPDATE users SET paused=? WHERE tg_id=?", body.paused ? 1 : 0, uid);
      if ("interval" in body) {
        const { interval } = cleanFields({ interval: body.interval });
        await run(env, "UPDATE users SET interval=? WHERE tg_id=?", interval, uid);
      }
      return json({ ok: true });
    }

    throw new HttpError("Not found", 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.log("api error", e.message, e.stack);
    return json({ error: "Внутренняя ошибка" }, 500);
  }
}
