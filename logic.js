// Логика: поиск по словам, оценка выгодности, дубликаты, CSV, AI-анализ (через AI Router из core.js)

import { aiJson, hashStr, aiQuotaCheck, aiQuotaCommit } from "./core.js";

// ───────── Слова: нормализация, синонимы, опечатки ─────────
const SYN = {
  айфон: "iphone", айфоны: "iphone", айфона: "iphone", самсунг: "samsung", самсунгов: "samsung",
  сяоми: "xiaomi", ксиоми: "xiaomi", редми: "redmi", хуавей: "huawei", хонор: "honor", поко: "poco",
  макбук: "macbook", айпад: "ipad", эпл: "apple", про: "pro", макс: "max", плюс: "plus", ультра: "ultra",
  мини: "mini", эйр: "air", аир: "air", ноутбук: "notebook", ноут: "notebook", нетбук: "notebook", laptop: "notebook",
  телефон: "phone", смартфон: "phone", планшет: "tablet", плейстейшн: "playstation", ксбокс: "xbox",
};
const STOP = new Set(["и", "в", "на", "с", "по", "для", "от", "до", "шт", "новый", "б", "у", "бу", "the", "a", "or"]);

export function tokens(s) {
  const raw = String(s || "").toLowerCase().replace(/ё/g, "е").match(/[a-zа-я]+|\d+/g) || [];
  return raw.map((t) => SYN[t] || t);
}

function lev1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
}

function tokEq(a, b) {
  if (a === b) return true;
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 4 && l.startsWith(s) && l.length - s.length <= 3) return true; // разбит / разбитый
  return s.length >= 5 && l.length >= 5 && lev1(a, b); // опечатка в одну букву
}

export function phraseMatch(textTokens, phrase) {
  const pt = tokens(phrase);
  return pt.length > 0 && pt.every((p) => textTokens.some((t) => tokEq(t, p)));
}

export const phrases = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
const ids = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

export function conditionOf(ad) {
  const v = String(ad.cond || "").toLowerCase();
  if (v) {
    if (/б\s*\/?\s*у|использ|вторич/.test(v)) return "used";
    if (/нов|запечат/.test(v)) return "new";
  }
  const t = `${ad.title} ${ad.desc}`.toLowerCase();
  if (/как нов|б\s*\/\s*у|(^|\s)бу(\s|$|,|\.)|идеал|использовал/.test(t)) return "used";
  if (/запечатан|новый|новая|новое|новые|в упаковке/.test(t)) return "new";
  return null;
}

// Проходит ли объявление фильтры категории и чёрные списки пользователя
export function passes(ad, c, user) {
  if (c.min_price != null && (ad.price == null || ad.price < c.min_price)) return false;
  if (c.max_price != null && (ad.price == null || ad.price > c.max_price)) return false;
  if (c.city && !String(ad.city || "").toLowerCase().includes(String(c.city).toLowerCase())) return false;
  const tt = tokens(`${ad.title} ${ad.desc}`);
  const kws = phrases(c.keywords);
  if (kws.length && !kws.some((k) => phraseMatch(tt, k))) return false;
  if (phrases(c.exclude).some((k) => phraseMatch(tt, k))) return false;
  if (user) {
    if (phrases(user.bl_words).some((k) => phraseMatch(tt, k))) return false;
    if (ad.seller && ids(user.bl_sellers).includes(String(ad.seller))) return false;
  }
  if (c.condition) {
    const cd = conditionOf(ad);
    if (cd && cd !== c.condition) return false; // если состояние не указано, не отсеиваем
  }
  return true;
}

export const rowToAd = (r) => ({
  id: r.ad_id, title: r.title, price: r.price, city: r.city, date: r.list_time, desc: r.descr || "",
  url: r.url, photo: r.photo, seller: r.seller, cond: r.cond, photos: r.photos || 0, params: r.params || 0,
});

// ───────── Статистика, аналоги, оценка ─────────
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
export function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null;
}
export function jaccard(A, B) {
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}
export const sigOf = (title) => [...new Set(tokens(title).filter((t) => !STOP.has(t)))].sort().join(" ");
export const dsigOf = (desc) => [...new Set(tokens(desc).filter((t) => t.length > 2 && !STOP.has(t)))].sort().slice(0, 80).join(" ");
const setOf = (s) => new Set(String(s || "").split(" ").filter(Boolean));

export function analogsFor(ad, pool) {
  const A = setOf(sigOf(ad.title));
  return pool.filter((r) => r.ad_id !== ad.id && r.price > 0 && jaccard(A, setOf(r.sig)) >= 0.5);
}

function quality(ad) {
  const d = (ad.desc || "").length;
  const desc = d >= 150 ? 100 : d >= 60 ? 70 : d > 0 ? 40 : 10;
  const photos = ad.photos >= 5 ? 100 : ad.photos >= 3 ? 80 : ad.photos >= 1 ? 50 : 0;
  const params = ad.params >= 4 ? 100 : ad.params >= 2 ? 70 : ad.params >= 1 ? 40 : 20;
  const cond = conditionOf(ad) ? 100 : 40;
  return { total: Math.round(desc * 0.3 + photos * 0.3 + params * 0.2 + cond * 0.2), parts: { desc, photos, params, cond } };
}

export function scoreAd(ad, analogs) {
  const prices = analogs.map((r) => r.price);
  const q = quality(ad);
  const out = { n: prices.length, quality: q.total, parts: q.parts, score: null, dev: null, devMean: null, mean: null, median: null, conf: null, notes: [] };
  if (!(ad.price > 0)) { out.notes.push("цена не указана"); return out; }
  if (prices.length < 5) { out.notes.push(`мало аналогов (${prices.length} из 5 нужных)`); return out; }
  out.median = median(prices);
  out.mean = mean(prices);
  out.dev = (ad.price - out.median) / out.median;
  out.devMean = (ad.price - out.mean) / out.mean;
  let ps = Math.max(0, Math.min(100, 50 - out.dev * 100 * 1.2));
  if (out.dev < -0.6) {
    ps = Math.min(ps, 70);
    out.notes.push("цена намного ниже рынка, проверь, нет ли подвоха");
  }
  out.score = Math.round(0.65 * ps + 0.35 * q.total);
  out.conf = prices.length >= 25 ? "высокая" : prices.length >= 10 ? "средняя" : "низкая";
  return out;
}

// ───────── Формат текста ─────────
export const money = (v) => (v == null ? "—" : `${Math.round(v)} BYN`);
const pct = (x) => `${x > 0 ? "+" : ""}${(x * 100).toFixed(1).replace(".", ",")}%`;
const escH = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function scoreBlock(ad, sc) {
  if (sc.score != null) {
    return (
      `⭐ Оценка: <b>${sc.score}/100</b> (достоверность: ${sc.conf}, аналогов: ${sc.n})\n` +
      `Цена: ${money(ad.price)} · средняя аналогов: ${money(sc.mean)} · медиана: ${money(sc.median)}\n` +
      `Отклонение: ${pct(sc.devMean)} от средней, ${pct(sc.dev)} от медианы` +
      (sc.notes.length ? `\n⚠️ ${escH(sc.notes.join("; "))}` : "") +
      `\n<i>Это ориентир по собранным данным, а не гарантия выгоды.</i>`
    );
  }
  return `⭐ Оценка цены: недостаточно данных (${escH(sc.notes.join("; "))})\nПолнота объявления: ${sc.quality}/100`;
}

export function priceChangeBlock(oldP, newP) {
  const ch = (newP - oldP) / oldP;
  const down = newP < oldP;
  return (
    `${down ? "📉 <b>ЦЕНА СНИЖЕНА</b>" : "📈 <b>ЦЕНА ПОВЫШЕНА</b>"}\n\nБыло: ${money(oldP)}\nСтало: ${money(newP)}\n` +
    `${down ? "Снижение" : "Повышение"}: ${Math.abs(ch * 100).toFixed(ch * 100 % 1 === 0 ? 0 : 1).replace(".", ",")}%`
  );
}

// ───────── Дубликаты и повторные публикации ─────────
// Объединяем только если совпадает продавец или сильно совпадает описание, одного названия мало
export function findRepost(ad, sig, dsig, seller, pool) {
  const A = setOf(sig);
  const D = setOf(dsig);
  for (const r of pool) {
    if (r.ad_id === ad.id) continue;
    if (jaccard(A, setOf(r.sig)) < 0.85) continue;
    const sameSeller = seller && r.seller && String(seller) === String(r.seller);
    const jd = D.size >= 8 && r.dsig ? jaccard(D, setOf(r.dsig)) : 0;
    if (sameSeller || jd >= 0.8) return { row: r, kind: sameSeller ? "repost" : "dup" };
  }
  return null;
}

// ───────── CSV (Excel открывает; разделитель «;») ─────────
export function toCsv(rows, cols) {
  const esc = (v) => {
    v = v == null ? "" : String(v);
    return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return "\ufeff" + [cols.map((c) => esc(c[1])).join(";"), ...rows.map((r) => cols.map((c) => esc(r[c[0]])).join(";"))].join("\r\n");
}

// ───────── AI-анализ объявления (бесплатные провайдеры через AI Router) ─────────
const clampInt = (v) => Math.max(1, Math.min(100, Math.round(Number(v) || 0)));
const strs = (a) => (Array.isArray(a) ? a.map((x) => String(x).slice(0, 220)).filter(Boolean).slice(0, 6) : []);

const ANALYSIS_SYSTEM =
  "Ты аналитик объявлений для покупателя. Используй ТОЛЬКО данные, которые даны в запросе. Правила: " +
  "1) не придумывай характеристики; 2) не выдавай предположения за факты, неизвестное называй «не указано»; " +
  "3) не утверждай, что товар оригинальный, исправный или без дефектов, если этого нет в данных; " +
  "4) отсутствие информации не доказывает плохое состояние, но снижает достоверность; 5) не сравнивай несопоставимые модели; " +
  "6) если данных мало, достоверность должна быть низкой. Учитывай специфику категории: смартфоны (модель, память, аккумулятор, комплект), " +
  "ноутбуки (процессор, видеокарта, ОЗУ, накопитель), авто (год, пробег, двигатель), недвижимость (площадь, район, состояние). " +
  "Фотографий ты не видишь, анализируй только текст и числа. Не показывай внутренние рассуждения, только проверяемые факты и выводы. " +
  'Ответь только JSON: {"attractiveness_score":1-100,"confidence_score":1-100,"market_position":"ниже рынка|около рынка|выше рынка|нет данных","positive_factors":[str],"negative_factors":[str],"missing_information":[str],"price_analysis":str,"condition_analysis":str,"risk_indicators":[str],"summary":str,"recommendation":str}. ' +
  "Всё по-русски, кратко, в списках не больше 5 пунктов. Риски формулируй как «стоит уточнить».";

function normalizeAnalysis(j, nAnalogs) {
  const out = {
    attractiveness_score: clampInt(j.attractiveness_score), confidence_score: clampInt(j.confidence_score),
    market_position: String(j.market_position || "нет данных").slice(0, 40),
    positive_factors: strs(j.positive_factors), negative_factors: strs(j.negative_factors), missing_information: strs(j.missing_information),
    price_analysis: String(j.price_analysis || "").slice(0, 500), condition_analysis: String(j.condition_analysis || "").slice(0, 500),
    risk_indicators: strs(j.risk_indicators), summary: String(j.summary || "").slice(0, 500), recommendation: String(j.recommendation || "").slice(0, 500),
  };
  if (nAnalogs < 5) out.confidence_score = Math.min(out.confidence_score, 45); // мало аналогов: уверенность не выше средней
  return out;
}

// Проверка полного анализа на примере (без записи в базу): /api/aitest?key=...&full=1
export async function analyzeSample(env) {
  const user = "Название: iPhone 13 128GB\nЦена: 1100 BYN\nГород: Минск\nСостояние (поле объявления): Б/у\nКоличество фото: 4\nКоличество указанных параметров: 3\n" +
    "Описание продавца: Телефон в хорошем состоянии, аккумулятор 87%, есть коробка и зарядка. Без торга.\nИстория цены: не менялась\nСопоставимых объявлений недостаточно (0), положение относительно рынка оценить нельзя.";
  return normalizeAnalysis(await aiJson(env, "analysis", ANALYSIS_SYSTEM, user, { maxTokens: 900, tgId: Number(env.OWNER_TELEGRAM_ID) || null }), 0);
}

// Анализ с кэшем в D1: повторно считается, только если объявление или цена заметно изменились либо прошла неделя
export async function analyzeAd(env, row, tgId = null) {
  const ad = rowToAd(row);
  const pool = (await env.DB.prepare("SELECT ad_id,title,price,sig FROM ads WHERE market=? ORDER BY first_seen DESC LIMIT 600").bind(row.market).all()).results;
  const analogs = analogsFor(ad, pool);
  const sc = scoreAd(ad, analogs);
  const hist = (await env.DB.prepare("SELECT price FROM price_hist WHERE ad_id=? ORDER BY ts").bind(row.ad_id).all()).results.map((h) => h.price);
  const hash = hashStr([ad.title, ad.price, (ad.desc || "").length, Math.floor(analogs.length / 5), hist.join(",")].join("|"));
  const cached = await env.DB.prepare("SELECT hash, json, ts FROM ai_analysis WHERE ad_id=?").bind(row.ad_id).first();
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.hash === hash && now - cached.ts < 7 * 86400) { try { return { ...JSON.parse(cached.json), cached: true }; } catch {} }

  const market = sc.score != null
    ? `Сопоставимых объявлений: ${sc.n}. Средняя цена: ${money(sc.mean)}, медиана: ${money(sc.median)}. Цена объявления отличается на ${pct(sc.devMean)} от средней и на ${pct(sc.dev)} от медианы.`
    : `Сопоставимых объявлений недостаточно (${sc.n}), положение относительно рынка оценить нельзя.`;
  const user =
    `Название: ${ad.title}\nЦена: ${ad.price ?? "не указана"} BYN\nГород: ${ad.city || "не указан"}\nСостояние (поле объявления): ${ad.cond || "не указано"}\n` +
    `Количество фото: ${ad.photos}\nКоличество указанных параметров: ${ad.params}\nОписание продавца: ${ad.desc || "(пусто)"}\n` +
    `История цены: ${hist.length > 1 ? hist.join(" → ") + " BYN" : "не менялась"}\n${market}`;
  const quota = await aiQuotaCheck(env, tgId, "analysis"); // кэш выше квоту не тратит
  const j = normalizeAnalysis(await aiJson(env, "analysis", ANALYSIS_SYSTEM, user, { maxTokens: 900, tgId }), sc.n);
  await aiQuotaCommit(env, tgId, quota);
  await env.DB.prepare("INSERT INTO ai_analysis(ad_id,hash,json,ts) VALUES(?,?,?,?) ON CONFLICT(ad_id) DO UPDATE SET hash=excluded.hash, json=excluded.json, ts=excluded.ts")
    .bind(row.ad_id, hash, JSON.stringify(j), now).run().catch(() => {});
  return j;
}

const list = (a) => (a && a.length ? a.map((x) => `• ${escH(x)}`).join("\n") : "—");
export const aiText = (j) =>
  `🤖 <b>AI-АНАЛИЗ</b>${j.cached ? " (из кэша)" : ""}\n\nПривлекательность: <b>${j.attractiveness_score}/100</b> · достоверность анализа: <b>${j.confidence_score}/100</b>\nПоложение: ${escH(j.market_position)}\n\n` +
  `<b>Кратко:</b> ${escH(j.summary || "—")}\n\n<b>Плюсы:</b>\n${list(j.positive_factors)}\n\n<b>Минусы:</b>\n${list(j.negative_factors)}\n\n` +
  `<b>Цена:</b> ${escH(j.price_analysis || "—")}\n<b>Состояние:</b> ${escH(j.condition_analysis || "—")}\n\n<b>Не хватает сведений:</b>\n${list(j.missing_information)}\n\n` +
  `<b>Риски (стоит уточнить):</b>\n${list(j.risk_indicators)}\n\n<b>Рекомендация:</b> ${escH(j.recommendation || "—")}\n\n<i>AI читает только текст и числа, фото не анализирует, и может ошибаться.</i>`;

export async function parseFilter(env, text, categories, regions, tgId = null) {
  const quota = await aiQuotaCheck(env, tgId, "nl");
  const j = await aiJson(
    env, "nl",
    "Преобразуй запрос покупателя в фильтр. Доступные категории (id: название): " + categories.map((c) => `${c.id}: ${c.name}`).join("; ") +
      ". Регионы (id: название): " + regions.map((r) => `${r.id}: ${r.name}`).join("; ") +
      '. Рубли = BYN. Ответь только JSON: {"category":id или null,"region":id или "all","min_price":число или null,"max_price":число или null,"city":строка или null,"keywords":[строки],"exclude":[строки],"condition":"new"|"used"|null,"note":строка}. ' +
      "В note кратко скажи, что не удалось определить. Не придумывай то, чего нет в запросе.",
    text, { maxTokens: 500, tgId }
  );
  await aiQuotaCommit(env, tgId, quota);
  return j;
}
