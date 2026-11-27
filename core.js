// Ядро: метрики использования, настройки, журнал событий, защита ресурсов,
// AI Router (только бесплатные провайдеры) и API админ-панели.

export class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Бесплатные лимиты Cloudflare (Workers Free): D1 5 млн чтений и 100 тыс. записей в день,
// 100 тыс. запросов Worker в день. Источник: developers.cloudflare.com/workers/platform/pricing
export const LIMITS = { d1Reads: 5_000_000, d1Writes: 100_000, requests: 100_000, d1SizeBytes: 500 * 1024 * 1024, cronPerDay: 1440 };

// ───────── Счётчики использования (считает сам бот) ─────────
export const U = { reads: 0, writes: 0, requests: 0, cron: 0, sent: 0, newAds: 0, ai: 0, errors: 0, size: 0, lastFlush: 0, sizeSaved: 0 };

function countMeta(m) {
  if (!m) return;
  U.reads += m.rows_read || 0;
  U.writes += m.rows_written || 0;
  if (m.size_after) U.size = m.size_after;
}
function wrapStmt(st) {
  return {
    __raw: st,
    bind: (...a) => wrapStmt(st.bind(...a)),
    all: async () => { const r = await st.all(); countMeta(r.meta); return r; },
    first: async () => { const r = await st.all(); countMeta(r.meta); return r.results[0] ?? null; },
    run: async () => { const r = await st.run(); countMeta(r.meta); return r; },
  };
}
function wrapDB(db) {
  return {
    __w: true,
    prepare: (sql) => wrapStmt(db.prepare(sql)),
    batch: async (stmts) => {
      const res = await db.batch(stmts.map((s) => s.__raw || s));
      (res || []).forEach((r) => countMeta(r?.meta));
      return res;
    },
  };
}
export const withEnv = (env) => (env.DB && !env.DB.__w ? { ...env, DB: wrapDB(env.DB) } : env);

const hourKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 13);
const dayKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

export async function flushUsage(env, force = false) {
  const now = Date.now();
  if (!force && now - U.lastFlush < 60000) return;
  const snap = { reads: U.reads, writes: U.writes, requests: U.requests, cron: U.cron, sent: U.sent, newAds: U.newAds, ai: U.ai, errors: U.errors };
  if (!Object.values(snap).some((v) => v)) return;
  for (const k of Object.keys(snap)) U[k] = 0;
  U.lastFlush = now;
  try {
    await env.DB.prepare(
      `INSERT INTO usage(h,reads,writes,requests,cron,sent,new_ads,ai,errors) VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(h) DO UPDATE SET reads=reads+excluded.reads, writes=writes+excluded.writes, requests=requests+excluded.requests,
       cron=cron+excluded.cron, sent=sent+excluded.sent, new_ads=new_ads+excluded.new_ads, ai=ai+excluded.ai, errors=errors+excluded.errors`
    ).bind(hourKey(now), snap.reads, snap.writes, snap.requests, snap.cron, snap.sent, snap.newAds, snap.ai, snap.errors).run();
    if (U.size && Math.abs(U.size - U.sizeSaved) > Math.max(1e6, U.sizeSaved * 0.02)) { U.sizeSaved = U.size; await setSetting(env, "d1.size", String(U.size)); }
  } catch {
    for (const k of Object.keys(snap)) U[k] += snap[k]; // не потеряли счётчики
  }
}

async function usageSum(env, like) {
  const r = await env.DB.prepare(
    "SELECT COALESCE(SUM(reads),0) r, COALESCE(SUM(writes),0) w, COALESCE(SUM(requests),0) q, COALESCE(SUM(cron),0) c, COALESCE(SUM(ai),0) a, COALESCE(SUM(errors),0) e, COALESCE(SUM(sent),0) s, COALESCE(SUM(new_ads),0) n FROM usage WHERE h LIKE ?"
  ).bind(like).first();
  return r;
}

// ───────── Настройки и журнал ─────────
const sCache = new Map();
export async function getSetting(env, key, def = null) {
  const c = sCache.get(key);
  if (c && Date.now() - c.t < 20000) return c.v ?? def;
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  sCache.set(key, { v: r ? r.value : null, t: Date.now() });
  return r ? r.value : def;
}
export async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, String(value)).run();
  sCache.set(key, { v: String(value), t: Date.now() });
}

export async function logEvent(env, type, tgId, message) {
  if (/error|security/.test(type)) U.errors++;
  try {
    await env.DB.prepare("INSERT INTO events(ts,type,tg_id,msg) VALUES(?,?,?,?)").bind(Math.floor(Date.now() / 1000), type, tgId ?? null, String(message).slice(0, 400)).run();
  } catch {}
}

// ───────── Resource Guard ─────────
let guardCache = { t: 0, v: null };
export async function guardInfo(env, fresh = false) {
  if (!fresh && guardCache.v && Date.now() - guardCache.t < 30000) return guardCache.v;
  let s;
  try { s = await usageSum(env, dayKey() + "%"); } catch { s = { r: 0, w: 0, q: 0, c: 0, a: 0, e: 0, s: 0, n: 0 }; }
  const reads = s.r + U.reads, writes = s.w + U.writes, requests = s.q + U.requests;
  const pct = Math.max(writes / LIMITS.d1Writes, reads / LIMITS.d1Reads, requests / LIMITS.requests);
  const level = pct >= 0.95 ? 95 : pct >= 0.85 ? 85 : pct >= 0.7 ? 70 : 0;
  guardCache = { t: Date.now(), v: { level, pct, reads, writes, requests, cron: s.c + U.cron, ai: s.a + U.ai, errors: s.e + U.errors, sent: s.s + U.sent, newAds: s.n + U.newAds } };
  return guardCache.v;
}
export const guardLevel = async (env) => (await guardInfo(env)).level;

// ───────── Схема таблиц ядра ─────────
export function coreSchema(env) {
  const p = (s) => env.DB.prepare(s);
  return [
    p("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)"),
    p("CREATE TABLE IF NOT EXISTS usage(h TEXT PRIMARY KEY, reads INTEGER DEFAULT 0, writes INTEGER DEFAULT 0, requests INTEGER DEFAULT 0, cron INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, new_ads INTEGER DEFAULT 0, ai INTEGER DEFAULT 0, errors INTEGER DEFAULT 0)"),
    p("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, tg_id INTEGER, msg TEXT)"),
    p("CREATE INDEX IF NOT EXISTS events_ts ON events(ts)"),
    p("CREATE TABLE IF NOT EXISTS ai_log(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, provider TEXT, model TEXT, task TEXT, ok INTEGER, status INTEGER, ms INTEGER, fallback INTEGER, tg_id INTEGER, err TEXT)"),
    p("CREATE INDEX IF NOT EXISTS ai_log_ts ON ai_log(ts)"),
    p("CREATE TABLE IF NOT EXISTS ai_analysis(ad_id TEXT PRIMARY KEY, hash TEXT, json TEXT, ts INTEGER)"),
    p("CREATE TABLE IF NOT EXISTS broadcasts(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, text TEXT, audience TEXT, total INTEGER, sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, status TEXT)"),
    p("CREATE TABLE IF NOT EXISTS broadcast_targets(bid INTEGER, tg_id INTEGER, status TEXT DEFAULT 'pending', error TEXT, PRIMARY KEY(bid, tg_id))"),
    p("CREATE TABLE IF NOT EXISTS tiers(id TEXT PRIMARY KEY, name TEXT, sort INTEGER, limits TEXT)"),
    p("CREATE TABLE IF NOT EXISTS promo_codes(code TEXT PRIMARY KEY, tier TEXT, days INTEGER, max_uses INTEGER, used INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created INTEGER)"),
    p("CREATE TABLE IF NOT EXISTS promo_uses(code TEXT, tg_id INTEGER, ts INTEGER, PRIMARY KEY(code, tg_id))"),
    ...DEFAULT_TIERS.map((t) => p("INSERT OR IGNORE INTO tiers(id,name,sort,limits) VALUES(?,?,?,?)").bind(t.id, t.name, t.sort, JSON.stringify(t.limits))),
  ];
}
export const coreAlters = [
  "ALTER TABLE users ADD COLUMN created_at INTEGER", "ALTER TABLE users ADD COLUMN last_seen INTEGER", "ALTER TABLE users ADD COLUMN username TEXT",
  "ALTER TABLE users ADD COLUMN first_name TEXT", "ALTER TABLE users ADD COLUMN blocked INTEGER DEFAULT 0", "ALTER TABLE users ADD COLUMN sent_total INTEGER DEFAULT 0",
  "ALTER TABLE categories ADD COLUMN last_ok INTEGER", "ALTER TABLE categories ADD COLUMN last_error TEXT",
  "ALTER TABLE users ADD COLUMN tier TEXT DEFAULT 'free'", "ALTER TABLE users ADD COLUMN tier_until INTEGER",
  "ALTER TABLE users ADD COLUMN ai_credits INTEGER DEFAULT 0", "ALTER TABLE users ADD COLUMN limits_reset INTEGER DEFAULT 0",
];


// ───────── Тарифная система (оплата не подключена: тарифы выдаёт владелец или промокод) ─────────
export const LIMIT_SPEC = {
  max_categories: { type: "int", min: 0, max: 100, label: "Категорий" },
  max_profiles: { type: "int", min: 1, max: 50, label: "Профилей поиска" },
  min_interval: { type: "int", min: 1, max: 1440, label: "Мин. интервал, мин" },
  ai_daily: { type: "int", min: 0, max: 1000, label: "AI-запросов в день" },
  history_days: { type: "int", min: 1, max: 365, label: "История, дней" },
  analytics: { type: "bool", label: "Аналитика" },
  export: { type: "bool", label: "Экспорт CSV" },
  photo_search: { type: "bool", label: "Поиск по фото (пока не реализован)" },
  nl_filter: { type: "bool", label: "Умный фильтр" },
  forward: { type: "bool", label: "Пересылка в чат" },
  reports: { type: "bool", label: "Отчёты в чат" },
  ai_analysis: { type: "bool", label: "AI-анализ" },
};
export const DEFAULT_TIERS = [
  { id: "free", name: "FREE", sort: 1, limits: { max_categories: 3, max_profiles: 1, min_interval: 10, ai_daily: 3, history_days: 7, analytics: false, export: false, photo_search: false, nl_filter: false, forward: false, reports: false, ai_analysis: true } },
  { id: "pro", name: "PRO", sort: 2, limits: { max_categories: 10, max_profiles: 3, min_interval: 5, ai_daily: 20, history_days: 30, analytics: true, export: true, photo_search: false, nl_filter: true, forward: true, reports: true, ai_analysis: true } },
  { id: "ultra", name: "ULTRA", sort: 3, limits: { max_categories: 25, max_profiles: 8, min_interval: 2, ai_daily: 60, history_days: 90, analytics: true, export: true, photo_search: true, nl_filter: true, forward: true, reports: true, ai_analysis: true } },
  { id: "business", name: "BUSINESS", sort: 4, limits: { max_categories: 100, max_profiles: 30, min_interval: 1, ai_daily: 200, history_days: 365, analytics: true, export: true, photo_search: true, nl_filter: true, forward: true, reports: true, ai_analysis: true } },
];
const UNLIMITED = { max_categories: 100, max_profiles: 50, min_interval: 1, ai_daily: 100000, history_days: 100000, analytics: true, export: true, photo_search: true, nl_filter: true, forward: true, reports: true, ai_analysis: true };
export const HARD_MAX_CATEGORIES = 100;

let tierCache = { t: 0, v: null };
export async function getTiers(env) {
  if (tierCache.v && Date.now() - tierCache.t < 60000) return tierCache.v;
  const rows = (await env.DB.prepare("SELECT id,name,sort,limits FROM tiers ORDER BY sort").all()).results;
  const map = new Map();
  for (const r of rows) {
    const def = DEFAULT_TIERS.find((d) => d.id === r.id)?.limits || DEFAULT_TIERS[0].limits;
    let lim = {};
    try { lim = JSON.parse(r.limits); } catch {}
    map.set(r.id, { id: r.id, name: r.name, sort: r.sort, limits: { ...def, ...lim } });
  }
  tierCache = { t: Date.now(), v: map };
  return map;
}
const isOwnerUser = (env, user) => !!env.OWNER_TELEGRAM_ID && String(user.tg_id) === String(env.OWNER_TELEGRAM_ID);
export const effectiveTierId = (user, now = Math.floor(Date.now() / 1000)) => (user.tier_until && user.tier_until < now ? "free" : user.tier || "free");

// Действующий тариф и лимиты пользователя. Владелец без ограничений.
export async function limitsFor(env, user) {
  if (isOwnerUser(env, user)) return { id: "owner", name: "Владелец", unlimited: true, limits: UNLIMITED, until: null };
  const tiers = await getTiers(env);
  const t = tiers.get(effectiveTierId(user)) || tiers.get("free");
  return { id: t.id, name: t.name, unlimited: false, limits: t.limits, until: user.tier_until || null };
}

export async function usageFor(env, user) {
  const dayStart = Math.floor(Date.now() / 86400000) * 86400;
  const since = Math.max(dayStart, user.limits_reset || 0);
  const [cats, prof, ai] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) c FROM categories WHERE tg_id=?").bind(user.tg_id).first(),
    env.DB.prepare("SELECT COUNT(DISTINCT COALESCE(profile,'')) c FROM categories WHERE tg_id=?").bind(user.tg_id).first(),
    env.DB.prepare("SELECT COUNT(*) c FROM ai_log WHERE tg_id=? AND ok=1 AND ts>=?").bind(user.tg_id, since).first(),
  ]);
  return { categories: cats.c, profiles: prof.c, ai_today: ai.c, ai_credits: user.ai_credits || 0 };
}

// Проверка квоты AI перед запросом и списание кредита после успешного ответа
export async function aiQuotaCheck(env, tgId, task) {
  if (tgId == null) return { credit: false };
  const user = await env.DB.prepare("SELECT * FROM users WHERE tg_id=?").bind(tgId).first();
  if (!user) return { credit: false };
  const t = await limitsFor(env, user);
  const flag = task === "nl" ? "nl_filter" : "ai_analysis";
  if (!t.limits[flag]) throw new HttpError(`Эта функция недоступна на тарифе ${t.name}. Её можно открыть на более высоком тарифе.`, 403);
  if (t.unlimited) return { credit: false };
  const used = (await usageFor(env, user)).ai_today;
  if (used < t.limits.ai_daily) return { credit: false };
  if ((user.ai_credits || 0) > 0) return { credit: true };
  throw new HttpError(`Лимит AI-запросов на сегодня исчерпан (${t.limits.ai_daily} на тарифе ${t.name}). Он обновится в 00:00 UTC.`, 429);
}
export async function aiQuotaCommit(env, tgId, q) {
  if (q?.credit && tgId != null) await env.DB.prepare("UPDATE users SET ai_credits=MAX(0,COALESCE(ai_credits,0)-1) WHERE tg_id=?").bind(tgId).run();
}

function grantTier(user, tier, days, now) {
  // продление: если тот же тариф ещё действует, добавляем дни к сроку; иначе отсчёт с сегодняшнего дня
  const same = effectiveTierId(user, now) === tier && user.tier_until && user.tier_until > now;
  return days ? (same ? user.tier_until : now) + days * 86400 : null;
}

export async function redeemPromo(env, uid, rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,24}$/.test(code)) throw new HttpError("Неверный формат промокода");
  const now = Math.floor(Date.now() / 1000);
  const p = await env.DB.prepare("SELECT * FROM promo_codes WHERE code=?").bind(code).first();
  if (!p || !p.active) throw new HttpError("Промокод не найден или отключён", 404);
  if (p.used >= p.max_uses) throw new HttpError("Лимит использований промокода исчерпан");
  if (await env.DB.prepare("SELECT 1 x FROM promo_uses WHERE code=? AND tg_id=?").bind(code, uid).first()) throw new HttpError("Ты уже использовал этот промокод");
  const user = await env.DB.prepare("SELECT * FROM users WHERE tg_id=?").bind(uid).first();
  const until = grantTier(user, p.tier, p.days, now);
  const claim = await env.DB.prepare("UPDATE promo_codes SET used=used+1 WHERE code=? AND used<max_uses AND active=1").bind(code).run();
  if (!claim.meta.changes) throw new HttpError("Лимит использований промокода исчерпан");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO promo_uses(code,tg_id,ts) VALUES(?,?,?)").bind(code, uid, now),
    env.DB.prepare("UPDATE users SET tier=?, tier_until=? WHERE tg_id=?").bind(p.tier, until, uid),
  ]);
  await logEvent(env, "tariff", uid, `промокод ${code}: тариф ${p.tier} на ${p.days} дн.`);
  const tier = (await getTiers(env)).get(p.tier);
  return { tier: p.tier, name: tier?.name || p.tier, until };
}

// ───────── AI Router: только бесплатные провайдеры ─────────
// Ключи провайдеров хранятся только в Cloudflare Secrets. Workers AI работает через привязку AI без ключа.
const PROVIDERS = {
  workers_ai: { name: "Cloudflare Workers AI", free: "10 000 нейронов в день на бесплатном плане (часть моделей требует платный план)", def: "@cf/google/gemma-4-26b-a4b-it", env: "WORKERS_AI_MODEL", ok: (e) => !!e.AI },
  groq: { name: "Groq", free: "бесплатный план, лимиты по моделям (запросы и токены)", def: "llama-3.3-70b-versatile", env: "GROQ_MODEL", ok: (e) => !!e.GROQ_API_KEY },
  gemini: { name: "Google Gemini (AI Studio)", free: "бесплатный уровень только для части моделей, возможны ограничения по региону", def: "gemini-3.5-flash", env: "GEMINI_MODEL", ok: (e) => !!e.GEMINI_API_KEY },
  openrouter: { name: "OpenRouter", free: "только модели с суффиксом :free, доступность меняется", def: "meta-llama/llama-3.3-70b-instruct:free", env: "OPENROUTER_MODEL", ok: (e) => !!e.OPENROUTER_API_KEY },
};
const DEFAULT_ORDER = ["workers_ai", "groq", "gemini", "openrouter"];
export const AI_FEATURES = { analysis: "Анализ объявления", nl: "Фильтр обычными словами" };

class AiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

async function providerOrder(env) {
  let order = DEFAULT_ORDER;
  try { const s = JSON.parse(await getSetting(env, "ai.order", "null")); if (Array.isArray(s)) order = s.filter((x) => PROVIDERS[x]).concat(DEFAULT_ORDER.filter((x) => !s.includes(x))); } catch {}
  return order;
}
const modelFor = async (env, p) => (await getSetting(env, `ai.model.${p}`)) || env[PROVIDERS[p].env] || PROVIDERS[p].def;

export async function aiAvailable(env) {
  for (const p of Object.keys(PROVIDERS)) {
    if (PROVIDERS[p].ok(env) && (await getSetting(env, `ai.enabled.${p}`, "1")) !== "0") return true;
  }
  return false;
}

function statusOf(e) {
  if (e instanceof AiError && e.status) return e.status;
  const m = String(e?.message || "");
  if (/429|3040|capacity|rate.?limit|too many|quota|neurons|exhaust/i.test(m)) return 429;
  if (/403|5035|forbidden|paid/i.test(m)) return 403;
  return 0;
}

// Запасные бесплатные модели Workers AI (список бесплатных моделей: changelog Cloudflare от 28.07.2026)
// Закрытые Cloudflare модели (nemotron-3-120b — 20.11.2026, llama-3.1-8b-instruct — 30.05.2026) убраны; быстрые llama без «рассуждений» взяты из актуального каталога
const WORKERS_AI_FALLBACKS = ["@cf/zai-org/glm-4.7-flash", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fp8", "@cf/meta/llama-4-scout-17b-16e-instruct"];
const asText = (x) => (x && typeof x === "object" ? JSON.stringify(x) : x);

// Возвращает варианты текста ответа (у «думающих» моделей JSON может оказаться в разных полях)
async function callProvider(env, p, model, system, user, maxTokens) {
  if (p === "workers_ai") {
    // запас токенов: «думающие» модели тратят часть на рассуждения и иначе возвращают пустой ответ
    const r = await env.AI.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: Math.max(maxTokens, 2500), temperature: 0.2 });
    const m = r?.choices?.[0]?.message;
    const out = [m?.content, r?.response, r?.result?.response, m?.reasoning_content, m?.reasoning, typeof r === "string" ? r : null].map(asText).filter((x) => typeof x === "string" && x.trim());
    if (!out.length) throw new AiError("пустой ответ модели (поля ответа: " + (r && typeof r === "object" ? Object.keys(r).join(",") : typeof r) + ")");
    return out;
  }
  if (p === "gemini") {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { maxOutputTokens: Math.max(maxTokens, 1500), temperature: 0.2, responseMimeType: "application/json" } }),
    });
    if (!r.ok) throw new AiError(`Gemini HTTP ${r.status}: ${(await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 220)}`, r.status);
    const j = await r.json();
    return [(j.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("")];
  }
  const url = p === "groq" ? "https://api.groq.com/openai/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
  const key = p === "groq" ? env.GROQ_API_KEY : env.OPENROUTER_API_KEY;
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "X-Title": "Kufar Helper" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: Math.max(maxTokens, 1500), temperature: 0.2 }),
  });
  if (!r.ok) throw new AiError(`${PROVIDERS[p].name} HTTP ${r.status}: ${(await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 220)}`, r.status);
  const j = await r.json();
  const m = j.choices?.[0]?.message;
  return [m?.content, m?.reasoning_content].filter((x) => typeof x === "string" && x.trim());
}

function parseJson(texts) {
  for (const t of Array.isArray(texts) ? texts : [texts]) {
    const m = String(t).replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    if (!m) continue;
    try { return JSON.parse(m[0]); } catch {}
  }
  throw new AiError("ответ не в формате JSON");
}

// Проверка всех подключённых провайдеров и моделей: /api/aitest?key=<WEBHOOK_SECRET>
export async function aiSelfTest(env) {
  const lines = [];
  for (const p of Object.keys(PROVIDERS)) {
    if (!PROVIDERS[p].ok(env)) { lines.push(`—    ${p}: не подключён`); continue; }
    const primary = await modelFor(env, p);
    const models = p === "workers_ai" ? [primary, ...WORKERS_AI_FALLBACKS.filter((x) => x !== primary)] : [primary];
    for (const m of models) {
      const t0 = Date.now();
      try {
        const texts = await callProvider(env, p, m, "Верни только JSON без пояснений.", 'Верни {"ok":true,"город":"Минск"}', 300);
        let ok = true;
        try { parseJson(texts); } catch { ok = false; }
        lines.push(`${ok ? "OK  " : "??  "} ${p} ${m} ${Date.now() - t0} мс | ${String(texts[0]).slice(0, 160).replace(/\s+/g, " ")}`);
      } catch (e) {
        lines.push(`FAIL ${p} ${m} ${Date.now() - t0} мс | код ${statusOf(e)} | ${e.name}: ${String(e.message).slice(0, 300)}`);
      }
    }
  }
  return lines.join("\n");
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// Единая точка вызова нейросети: проверка отключения, кэш, ресурсы, перебор провайдеров и моделей (каждая пробуется один раз)
export async function aiJson(env, task, system, user, opts = {}) {
  const { maxTokens = 800, cacheKey = null, tgId = null } = opts;
  if ((await getSetting(env, `ai.feature.${task}`, "1")) === "0") throw new AiError("Эта AI-функция отключена администратором", 403);
  if (cacheKey) {
    const c = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(`aic.${cacheKey}`).first();
    if (c) { try { return JSON.parse(c.value); } catch {} }
  }
  if ((await guardLevel(env)) >= 85) throw new AiError("AI отложен: близок лимит ресурсов Cloudflare. Мониторинг продолжает работать, попробуй позже.", 503);

  const now = Math.floor(Date.now() / 1000);
  const attempts = [];
  for (const p of await providerOrder(env)) {
    if (!PROVIDERS[p].ok(env)) continue;
    if ((await getSetting(env, `ai.enabled.${p}`, "1")) === "0") continue;
    if (Number(await getSetting(env, `ai.cool.${p}`, "0")) > now) continue;
    const primary = await modelFor(env, p);
    if (p === "workers_ai") for (const m of [primary, ...WORKERS_AI_FALLBACKS.filter((x) => x !== primary)]) attempts.push([p, m]);
    else attempts.push([p, primary]);
  }
  if (!attempts.length) throw new AiError("Нет доступных бесплатных AI-провайдеров (не подключены, отключены или исчерпали лимит)", 503);

  const stat = {}, failures = [];
  const settle = async () => {
    // провайдер, у которого все попытки закончились 429, отдыхает: минуту, а при исчерпании суточного лимита до полуночи UTC
    for (const [p, s] of Object.entries(stat)) {
      if (s.n > 0 && s.n === s.n429) {
        const until = s.daily ? Math.floor(Date.now() / 86400000 + 1) * 86400 : now + 60;
        await setSetting(env, `ai.cool.${p}`, until).catch(() => {});
      }
    }
  };
  for (let i = 0; i < attempts.length; i++) {
    const [p, model] = attempts[i], t0 = Date.now();
    const log = (ok, status, err) => env.DB.prepare("INSERT INTO ai_log(ts,provider,model,task,ok,status,ms,fallback,tg_id,err) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(now, p, model, task, ok ? 1 : 0, status, Date.now() - t0, i > 0 ? 1 : 0, tgId, err ? String(err).slice(0, 200) : null).run().catch(() => {});
    U.ai++;
    try {
      const data = parseJson(await callProvider(env, p, model, system, user, maxTokens));
      await log(true, 200, null);
      await settle();
      if (cacheKey) await setSetting(env, `aic.${cacheKey}`, JSON.stringify(data)).catch(() => {});
      return data;
    } catch (e) {
      const st = statusOf(e);
      await log(false, st, e.message);
      const s = (stat[p] = stat[p] || { n: 0, n429: 0, daily: false });
      s.n++;
      if (st === 429) { s.n429++; if (/neurons|daily|3036|4006/i.test(e.message)) s.daily = true; }
      failures.push(`${p} ${model.split("/").pop()}: ${String(e.message).slice(0, 90)}`);
      await logEvent(env, "ai_error", tgId, `${p} ${model}: ${e.message}`);
    }
  }
  await settle();
  const owner = tgId != null && env.OWNER_TELEGRAM_ID && String(tgId) === String(env.OWNER_TELEGRAM_ID);
  throw new AiError("Все бесплатные AI-провайдеры сейчас недоступны или исчерпали лимиты. Мониторинг работает как обычно." + (owner ? "\nДетали для владельца: " + failures.slice(0, 4).join("; ") : ""), 503);
}

// ───────── Рассылки: отправка порциями по Cron ─────────
export async function processBroadcasts(env, sendFn) {
  const b = await env.DB.prepare("SELECT * FROM broadcasts WHERE status='running' ORDER BY id LIMIT 1").first();
  if (!b) return;
  const targets = (await env.DB.prepare("SELECT tg_id FROM broadcast_targets WHERE bid=? AND status='pending' LIMIT 20").bind(b.id).all()).results;
  const stmts = [];
  for (const t of targets) {
    const r = await sendFn(t.tg_id, b.text);
    if (r.ok) stmts.push(env.DB.prepare("UPDATE broadcast_targets SET status='sent' WHERE bid=? AND tg_id=?").bind(b.id, t.tg_id));
    else {
      stmts.push(env.DB.prepare("UPDATE broadcast_targets SET status='failed', error=? WHERE bid=? AND tg_id=?").bind(String(r.description || r.error_code || "ошибка").slice(0, 120), b.id, t.tg_id));
      if (r.error_code === 403) stmts.push(env.DB.prepare("UPDATE users SET paused=1 WHERE tg_id=?").bind(t.tg_id));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  const c = await env.DB.prepare("SELECT SUM(status='sent') s, SUM(status='failed') f, SUM(status='pending') p FROM broadcast_targets WHERE bid=?").bind(b.id).first();
  await env.DB.prepare("UPDATE broadcasts SET sent=?, failed=?, status=? WHERE id=?").bind(c.s || 0, c.f || 0, (c.p || 0) > 0 ? "running" : "done", b.id).run();
}

// ───────── API админ-панели (только владелец, проверка в api.js) ─────────
const num0 = (v) => Number(v) || 0;

export async function handleAdmin(env, ownerId, path, method, q, body) {
  const now = Math.floor(Date.now() / 1000);
  const sub = path.replace("/api/admin/", "");
  const audit = (msg) => logEvent(env, "admin", ownerId, msg);

  if (sub === "dashboard") {
    const period = ["24h", "7d", "30d", "90d"].includes(q.get("period")) ? q.get("period") : "7d";
    const secs = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "90d": 90 * 86400 }[period];
    const since = now - secs, hourly = period === "24h";
    const [users, active, regs, cats, monitored, adsTotal, aiBy, usageRows, newUsers] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) c FROM users").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM users WHERE last_seen>=?").bind(since).first(),
      env.DB.prepare("SELECT COUNT(*) c FROM users WHERE created_at>=?").bind(since).first(),
      env.DB.prepare("SELECT COUNT(*) c FROM categories WHERE active=1").first(),
      env.DB.prepare("SELECT COUNT(DISTINCT c.tg_id) c FROM categories c JOIN users u ON u.tg_id=c.tg_id WHERE c.active=1 AND u.paused=0 AND u.blocked=0").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM ads").first(),
      env.DB.prepare("SELECT provider, COUNT(*) n, SUM(ok) ok FROM ai_log WHERE ts>=? GROUP BY provider").bind(since).all(),
      env.DB.prepare(`SELECT ${hourly ? "h" : "substr(h,1,10)"} t, SUM(new_ads) new_ads, SUM(sent) sent, SUM(ai) ai, SUM(errors) errors, SUM(requests) requests FROM usage WHERE h>=? GROUP BY t ORDER BY t`)
        .bind(hourly ? hourKey((since) * 1000) : dayKey(since * 1000)).all(),
      env.DB.prepare("SELECT created_at FROM users WHERE created_at>=?").bind(since).all(),
    ]);
    const byKey = new Map(newUsers.results.map((r) => [hourly ? hourKey(r.created_at * 1000) : dayKey(r.created_at * 1000), 0]));
    for (const r of newUsers.results) { const k = hourly ? hourKey(r.created_at * 1000) : dayKey(r.created_at * 1000); byKey.set(k, (byKey.get(k) || 0) + 1); }
    const series = usageRows.results.map((r) => ({ t: r.t, new_ads: num0(r.new_ads), sent: num0(r.sent), ai: num0(r.ai), errors: num0(r.errors), requests: num0(r.requests), new_users: byKey.get(r.t) || 0 }));
    const tot = series.reduce((a, s) => ({ new_ads: a.new_ads + s.new_ads, sent: a.sent + s.sent, ai: a.ai + s.ai, errors: a.errors + s.errors }), { new_ads: 0, sent: 0, ai: 0, errors: 0 });
    const cron = JSON.parse((await getSetting(env, "cron.last", "null")) || "null");
    const g = await guardInfo(env);
    return {
      period, users: users.c, active: active.c, new_users: regs.c, active_searches: cats.c, monitored_users: monitored.c, ads_total: adsTotal.c, totals: tot,
      ai_by_provider: aiBy.results, series, finance: { connected: false },
      by_tier: (await env.DB.prepare("SELECT CASE WHEN tier_until IS NOT NULL AND tier_until<? THEN 'free' ELSE COALESCE(tier,'free') END t, COUNT(*) n FROM users GROUP BY t").bind(now).all()).results,
      status: { cron_age: cron ? now - cron.ts : null, cron_ok: !!cron && now - cron.ts < 300, guard: g.level, maintenance: (await getSetting(env, "maintenance", "0")) === "1" },
      note: "«Прислано» и «новые объявления» считаются по реально отправленным уведомлениям и сохранённым объявлениям с момента включения учёта.",
    };
  }

  if (sub === "users") {
    const text = (q.get("q") || "").trim();
    const offset = Math.max(0, Number(q.get("offset")) || 0);
    const where = text ? "WHERE CAST(u.tg_id AS TEXT) LIKE ? OR u.username LIKE ?" : "";
    const args = text ? [`%${text}%`, `%${text.replace(/^@/, "")}%`] : [];
    const rows = (await env.DB.prepare(
      `SELECT u.tg_id, u.username, u.first_name, u.created_at, u.last_seen, u.paused, u.blocked, u.sent_total, u.tier, u.tier_until, u.ai_credits,
        (SELECT COUNT(*) FROM categories c WHERE c.tg_id=u.tg_id) cats, (SELECT COUNT(*) FROM ai_log a WHERE a.tg_id=u.tg_id) ai
       FROM users u ${where} ORDER BY COALESCE(u.last_seen,0) DESC LIMIT 30 OFFSET ?`).bind(...args, offset).all()).results;
    return { items: rows, offset, next: rows.length === 30 ? offset + 30 : null, tariff_note: "Тариф, срок, AI-кредиты и сброс лимитов меняются в карточке пользователя." };
  }

  if (sub === "user") {
    const id = Number(q.get("id") || body.id);
    if (!Number.isSafeInteger(id)) throw new HttpError("Нужен ID пользователя");
    if (method === "POST") {
      if (id === Number(ownerId)) throw new HttpError("Нельзя менять владельца");
      if (body.action === "block" || body.action === "unblock") {
        const r = await env.DB.prepare("UPDATE users SET blocked=? WHERE tg_id=?").bind(body.action === "block" ? 1 : 0, id).run();
        if (!r.meta.changes) throw new HttpError("Пользователь не найден", 404);
        await audit(`${body.action === "block" ? "заблокирован" : "разблокирован"} пользователь ${id}`);
        return { ok: true };
      }
      if (body.action === "tier") {
        const tiers = await getTiers(env);
        if (!tiers.has(body.tier)) throw new HttpError("Неизвестный тариф");
        const days = body.days === "" || body.days == null ? null : Math.floor(Number(body.days));
        if (days !== null && !(days >= 1 && days <= 3650)) throw new HttpError("Срок: от 1 до 3650 дней или пусто (бессрочно)");
        const until = days ? now + days * 86400 : null;
        const r = await env.DB.prepare("UPDATE users SET tier=?, tier_until=? WHERE tg_id=?").bind(body.tier, until, id).run();
        if (!r.meta.changes) throw new HttpError("Пользователь не найден", 404);
        await audit(`тариф пользователя ${id}: ${body.tier}${days ? ` на ${days} дн.` : " бессрочно"}`);
        await logEvent(env, "tariff", id, `тариф ${body.tier}${days ? ` на ${days} дн.` : " бессрочно"} (выдал владелец)`);
        return { ok: true };
      }
      if (body.action === "credits") {
        const n = Math.floor(Number(body.amount));
        if (!(n >= 1 && n <= 1000)) throw new HttpError("Кредиты: от 1 до 1000");
        const r = await env.DB.prepare("UPDATE users SET ai_credits=COALESCE(ai_credits,0)+? WHERE tg_id=?").bind(n, id).run();
        if (!r.meta.changes) throw new HttpError("Пользователь не найден", 404);
        await audit(`AI-кредиты пользователю ${id}: +${n}`);
        return { ok: true };
      }
      if (body.action === "reset_limits") {
        const r = await env.DB.prepare("UPDATE users SET limits_reset=? WHERE tg_id=?").bind(now + 1, id).run();
        if (!r.meta.changes) throw new HttpError("Пользователь не найден", 404);
        await audit(`сброшены дневные лимиты пользователя ${id}`);
        return { ok: true };
      }
      throw new HttpError("Неизвестное действие");
    }
    const [u, cats, ev] = await Promise.all([
      env.DB.prepare("SELECT tg_id,username,first_name,created_at,last_seen,paused,blocked,sent_total,quiet,report,tier,tier_until,ai_credits,limits_reset FROM users WHERE tg_id=?").bind(id).first(),
      env.DB.prepare("SELECT title, active, last_check, last_ok, last_error FROM categories WHERE tg_id=?").bind(id).all(),
      env.DB.prepare("SELECT ts,type,msg FROM events WHERE tg_id=? ORDER BY id DESC LIMIT 30").bind(id).all(),
    ]);
    if (!u) throw new HttpError("Пользователь не найден", 404);
    const tariff = await limitsFor(env, u), usage = await usageFor(env, u);
    return { user: u, categories: cats.results, events: ev.results, tariff: { id: tariff.id, name: tariff.name, until: tariff.until, limits: tariff.limits }, usage };
  }

  if (sub === "ai") {
    if (method === "POST") {
      if (body.provider) {
        if (!PROVIDERS[body.provider]) throw new HttpError("Неизвестный провайдер");
        if ("enabled" in body) { await setSetting(env, `ai.enabled.${body.provider}`, body.enabled ? "1" : "0"); await audit(`AI: провайдер ${body.provider} ${body.enabled ? "включён" : "отключён"}`); }
        if (typeof body.model === "string") { await setSetting(env, `ai.model.${body.provider}`, body.model.trim().slice(0, 120)); await audit(`AI: модель ${body.provider} = ${body.model}`); }
        if (body.reset_cooldown) await setSetting(env, `ai.cool.${body.provider}`, "0");
      }
      if (Array.isArray(body.order)) { await setSetting(env, "ai.order", JSON.stringify(body.order.filter((x) => PROVIDERS[x]))); await audit("AI: изменён приоритет провайдеров"); }
      if (body.feature) {
        if (!AI_FEATURES[body.feature]) throw new HttpError("Неизвестная AI-функция");
        await setSetting(env, `ai.feature.${body.feature}`, body.featureEnabled ? "1" : "0"); await audit(`AI: функция ${body.feature} ${body.featureEnabled ? "включена" : "отключена"}`);
      }
      return { ok: true };
    }
    const since24 = now - 86400, since7 = now - 7 * 86400;
    const order = await providerOrder(env);
    const stat = async (p, since) => env.DB.prepare("SELECT COUNT(*) n, COALESCE(SUM(ok),0) ok, COALESCE(SUM(status=429),0) e429, AVG(CASE WHEN ok=1 THEN ms END) avg FROM ai_log WHERE provider=? AND ts>=?").bind(p, since).first();
    const providers = [];
    for (const p of order) {
      const [s24, s7] = await Promise.all([stat(p, since24), stat(p, since7)]);
      providers.push({
        id: p, name: PROVIDERS[p].name, free: PROVIDERS[p].free, configured: PROVIDERS[p].ok(env), enabled: (await getSetting(env, `ai.enabled.${p}`, "1")) !== "0",
        model: await modelFor(env, p), cooldown_until: Number(await getSetting(env, `ai.cool.${p}`, "0")) > now ? Number(await getSetting(env, `ai.cool.${p}`, "0")) : null,
        d1: { n: s24.n, ok: s24.ok, errors: s24.n - s24.ok, e429: s24.e429, avg_ms: s24.avg ? Math.round(s24.avg) : null }, d7: { n: s7.n, ok: s7.ok, errors: s7.n - s7.ok, e429: s7.e429, avg_ms: s7.avg ? Math.round(s7.avg) : null },
      });
    }
    const [errs, sw, cached, analyses] = await Promise.all([
      env.DB.prepare("SELECT ts,provider,status,err FROM ai_log WHERE ok=0 ORDER BY id DESC LIMIT 15").all(),
      env.DB.prepare("SELECT ts,provider,task FROM ai_log WHERE fallback=1 AND ok=1 ORDER BY id DESC LIMIT 15").all(),
      env.DB.prepare("SELECT COUNT(*) c FROM settings WHERE key LIKE 'aic.%'").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM ai_analysis").first(),
    ]);
    const features = [];
    for (const f of Object.keys(AI_FEATURES)) features.push({ id: f, name: AI_FEATURES[f], enabled: (await getSetting(env, `ai.feature.${f}`, "1")) !== "0" });
    return { providers, errors: errs.results, switches: sw.results, cached: cached.c, analyses: analyses.c, features, keys_note: "Ключи провайдеров хранятся в Cloudflare Secrets и здесь не показываются." };
  }

  if (sub === "monitoring") {
    if (method === "POST") {
      const id = Number(body.id);
      if (body.action === "check_now") await env.DB.prepare("UPDATE categories SET last_check=0 WHERE id=?").bind(id).run();
      else if (body.action === "activate" || body.action === "deactivate") await env.DB.prepare("UPDATE categories SET active=? WHERE id=?").bind(body.action === "activate" ? 1 : 0, id).run();
      else throw new HttpError("Неизвестное действие");
      await audit(`мониторинг: ${body.action} категория ${id}`);
      return { ok: true };
    }
    const [cats, monitored, adsToday, adsAll, lag, failing, list, errs] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) c FROM categories WHERE active=1").first(),
      env.DB.prepare("SELECT COUNT(DISTINCT c.tg_id) c FROM categories c JOIN users u ON u.tg_id=c.tg_id WHERE c.active=1 AND u.paused=0 AND u.blocked=0").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM ads WHERE first_seen>=?").bind(now - 86400).first(),
      env.DB.prepare("SELECT COUNT(*) c FROM ads").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM categories c JOIN users u ON u.tg_id=c.tg_id WHERE c.active=1 AND u.paused=0 AND u.blocked=0 AND c.last_check + c.interval*180 < ?").bind(now).first(),
      env.DB.prepare("SELECT COUNT(*) c FROM categories WHERE active=1 AND last_error IS NOT NULL").first(),
      env.DB.prepare("SELECT c.id, c.tg_id, c.title, c.interval, c.active, c.last_check, c.last_ok, c.last_error FROM categories c ORDER BY c.last_check ASC LIMIT 30").all(),
      env.DB.prepare("SELECT ts,msg FROM events WHERE type='cron_error' ORDER BY id DESC LIMIT 10").all(),
    ]);
    const cron = JSON.parse((await getSetting(env, "cron.last", "null")) || "null");
    return {
      active_categories: cats.c, monitored_users: monitored.c, ads_total: adsAll.c, ads_24h: adsToday.c, lagging: lag.c, failing: failing.c,
      cron, cron_age: cron ? now - cron.ts : null, categories: list.results, errors: errs.results,
      queue_note: "Отдельной очереди нет: Cron берёт самые давно проверенные категории. «Отстают» — категории, не проверявшиеся втрое дольше своего интервала.",
    };
  }

  if (sub === "resources") {
    const g = await guardInfo(env, true);
    const size = Number(await getSetting(env, "d1.size", "0")) || U.size || null;
    const mk = (key, label, used, limit, note) => ({ key, label, used, limit, pct: limit ? used / limit : null, available: true, note });
    return {
      level: g.level, thresholds: [70, 85, 95],
      metrics: [
        mk("d1r", "D1: чтение строк за сутки", g.reads, LIMITS.d1Reads), mk("d1w", "D1: запись строк за сутки", g.writes, LIMITS.d1Writes),
        mk("req", "Запросы Worker за сутки", g.requests, LIMITS.requests), mk("cron", "Запуски Cron за сутки", g.cron, LIMITS.cronPerDay),
        size ? mk("size", "Размер базы D1", size, LIMITS.d1SizeBytes, "лимит 500 МБ на базу на бесплатном плане по документации D1") : { key: "size", label: "Размер базы D1", available: false, note: "Появится после первой записи метрик" },
        { key: "ai", label: "AI-запросы за сутки (учтены ботом)", used: g.ai, limit: null, available: true, note: "Расход нейронов Workers AI Cloudflare в API не отдаёт, смотри в панели Workers AI" },
        { key: "errors", label: "Ошибки Worker за сутки (учтены ботом)", used: g.errors, limit: null, available: true },
        { key: "queues", label: "Очереди Cloudflare", available: false, note: "Не подключены" }, { key: "kv", label: "Cloudflare KV", available: false, note: "Не подключён" },
      ],
      actions: { 70: "пропускаются отчёты", 85: "AI и рассылки приостановлены, проверка избранного отложена, за запуск Cron берутся 2 категории", 95: "за запуск Cron берётся 1 категория, мониторинг остаётся главным приоритетом" },
      note: "Показатели считает сам бот по ответам D1 и могут отличаться от панели Cloudflare. Официальные метрики через GraphQL API требуют отдельный API-токен, он не подключён.",
    };
  }

  if (sub === "tariffs") {
    if (method === "POST") {
      const tiers = await getTiers(env);
      const t = tiers.get(body.id);
      if (!t) throw new HttpError("Неизвестный тариф");
      const next = { ...t.limits };
      for (const [k, v] of Object.entries(body.limits || {})) {
        const sp = LIMIT_SPEC[k];
        if (!sp) throw new HttpError(`Неизвестный лимит: ${k}`);
        if (sp.type === "bool") next[k] = !!v;
        else {
          const n = Math.floor(Number(v));
          if (!Number.isFinite(n) || n < sp.min || n > sp.max) throw new HttpError(`${sp.label}: от ${sp.min} до ${sp.max}`);
          next[k] = n;
        }
      }
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 20) : t.name;
      await env.DB.prepare("UPDATE tiers SET name=?, limits=? WHERE id=?").bind(name, JSON.stringify(next), t.id).run();
      tierCache = { t: 0, v: null };
      await audit(`тариф ${t.id}: изменены лимиты`);
      return { ok: true };
    }
    const tiers = [...(await getTiers(env)).values()];
    const counts = (await env.DB.prepare("SELECT CASE WHEN tier_until IS NOT NULL AND tier_until<? THEN 'free' ELSE COALESCE(tier,'free') END t, COUNT(*) n FROM users GROUP BY t").bind(now).all()).results;
    return { tiers: tiers.map((t) => ({ ...t, users: counts.find((c) => c.t === t.id)?.n || 0 })), spec: LIMIT_SPEC, note: "Лимиты проверяются на сервере. Изменение действует сразу (в течение минуты). Владелец без ограничений. Поиск по фото пока не реализован, флаг подготовлен." };
  }

  if (sub === "promos") {
    if (method === "POST") {
      if (body.action === "toggle") {
        const r = await env.DB.prepare("UPDATE promo_codes SET active=1-active WHERE code=?").bind(String(body.code || "").toUpperCase()).run();
        if (!r.meta.changes) throw new HttpError("Промокод не найден", 404);
        await audit(`промокод ${body.code}: переключён`);
        return { ok: true };
      }
      const code = String(body.code || "").trim().toUpperCase();
      if (!/^[A-Z0-9_-]{3,24}$/.test(code)) throw new HttpError("Код: 3–24 символа, латиница, цифры, - и _");
      if (!(await getTiers(env)).has(body.tier) || body.tier === "free") throw new HttpError("Выбери платный тариф");
      const days = Math.floor(Number(body.days)), max = Math.floor(Number(body.max_uses));
      if (!(days >= 1 && days <= 365)) throw new HttpError("Срок: от 1 до 365 дней");
      if (!(max >= 1 && max <= 10000)) throw new HttpError("Число использований: от 1 до 10000");
      try { await env.DB.prepare("INSERT INTO promo_codes(code,tier,days,max_uses,created) VALUES(?,?,?,?,?)").bind(code, body.tier, days, max, now).run(); }
      catch { throw new HttpError("Такой промокод уже есть"); }
      await audit(`создан промокод ${code}: ${body.tier}, ${days} дн., ${max} использований`);
      return { ok: true };
    }
    return { items: (await env.DB.prepare("SELECT code,tier,days,max_uses,used,active,created FROM promo_codes ORDER BY created DESC LIMIT 50").all()).results };
  }

  if (sub === "finance") {
    const byTier = (await env.DB.prepare("SELECT CASE WHEN tier_until IS NOT NULL AND tier_until<? THEN 'free' ELSE COALESCE(tier,'free') END t, COUNT(*) n FROM users GROUP BY t").bind(now).all()).results;
    const manual = await env.DB.prepare("SELECT COUNT(*) c FROM users WHERE COALESCE(tier,'free')!='free' AND (tier_until IS NULL OR tier_until>=?)").bind(now).first();
    const promos = await env.DB.prepare("SELECT COUNT(*) c FROM promo_uses").first();
    return {
      connected: false, by_tier: byTier, manual_active: manual.c, promo_uses: promos.c,
      message: "Платёжная система не подключена. Выручки, платежей, возвратов и MRR нет, я не показываю выдуманных цифр. Платные тарифы сейчас выдаются вручную или по промокодам, это не продажи. Оплату подключим отдельным этапом после твоего разрешения.",
    };
  }

  if (sub === "settings") {
    if (method === "POST") {
      if ("maintenance" in body) { await setSetting(env, "maintenance", body.maintenance ? "1" : "0"); await audit(`технические работы ${body.maintenance ? "включены" : "выключены"}`); }
      return { ok: true };
    }
    return { maintenance: (await getSetting(env, "maintenance", "0")) === "1", owner_id: ownerId, notes: ["Режим техработ закрывает Mini App для обычных пользователей. Мониторинг и уведомления продолжают работать.", "Тарифы, лимиты, промокоды и рефералы будут на этапе тарифной системы."] };
  }

  if (sub === "broadcast") {
    const audiences = {
      all: ["Все пользователи", "SELECT tg_id FROM users WHERE blocked=0"],
      active7: ["Активные за 7 дней", `SELECT tg_id FROM users WHERE blocked=0 AND last_seen>=${now - 7 * 86400}`],
      monitoring: ["С включённым мониторингом", "SELECT DISTINCT u.tg_id FROM users u JOIN categories c ON c.tg_id=u.tg_id WHERE u.blocked=0 AND u.paused=0 AND c.active=1"],
    };
    if (method === "POST") {
      const text = String(body.text || "").trim();
      if (!text) throw new HttpError("Напиши текст сообщения");
      if (text.length > 3500) throw new HttpError("Слишком длинное сообщение");
      const a = audiences[body.audience];
      if (!a) throw new HttpError("Выбери аудиторию");
      const targets = (await env.DB.prepare(a[1]).all()).results;
      if (!body.confirm) return { preview: true, count: targets.length, audience: a[0], text };
      if (Number(body.expected) !== targets.length) throw new HttpError("Аудитория изменилась, посмотри предпросмотр ещё раз");
      if (!targets.length) throw new HttpError("В выбранной аудитории никого нет");
      const r = await env.DB.prepare("INSERT INTO broadcasts(ts,text,audience,total,status) VALUES(?,?,?,?,'running')").bind(now, text, body.audience, targets.length).run();
      const bid = r.meta.last_row_id;
      for (let i = 0; i < targets.length; i += 40) {
        await env.DB.batch(targets.slice(i, i + 40).map((t) => env.DB.prepare("INSERT OR IGNORE INTO broadcast_targets(bid,tg_id) VALUES(?,?)").bind(bid, t.tg_id)));
      }
      await audit(`рассылка #${bid}: ${targets.length} получателей (${a[0]})`);
      return { ok: true, id: bid, total: targets.length };
    }
    const list = (await env.DB.prepare("SELECT id, ts, substr(text,1,100) preview, audience, total, sent, failed, status FROM broadcasts ORDER BY id DESC LIMIT 10").all()).results;
    const failed = list.length ? (await env.DB.prepare("SELECT tg_id, error FROM broadcast_targets WHERE bid=? AND status='failed' LIMIT 10").bind(list[0].id).all()).results : [];
    return { items: list, failed, audiences: Object.fromEntries(Object.entries(audiences).map(([k, v]) => [k, v[0]])) };
  }

  if (sub === "logs") {
    const where = [], args = [];
    if (q.get("type")) { where.push("type=?"); args.push(q.get("type")); }
    if (q.get("user")) { where.push("tg_id=?"); args.push(Number(q.get("user"))); }
    if (q.get("from")) { where.push("ts>=?"); args.push(Math.floor(Date.parse(q.get("from") + "T00:00:00Z") / 1000) || 0); }
    if (q.get("to")) { where.push("ts<?"); args.push(Math.floor(Date.parse(q.get("to") + "T00:00:00Z") / 1000) + 86400 || now + 86400); }
    const rows = (await env.DB.prepare(`SELECT ts,type,tg_id,msg FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 100`).bind(...args).all()).results;
    const types = (await env.DB.prepare("SELECT DISTINCT type FROM events").all()).results.map((r) => r.type);
    return { items: rows, types };
  }

  throw new HttpError("Not found", 404);
}
