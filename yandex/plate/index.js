// Поиск машины по госномеру для Яндекс Облака (Cloud Functions, Node.js 22).
// Сайт отправляет POST {"plate": "А123ВС77"}, функция спрашивает api-cloud.ru:
//   1) госномер → марка, модель, год, VIN;
//   2) по VIN: ДТП, розыск, ограничения (данные Госавтоинспекции).
// Данные владельца (ФИО, телефон, адрес) не запрашиваются и не отдаются (152-ФЗ).
//
// Переменные окружения функции:
//   API_CLOUD_TOKEN   — ключ api-cloud.ru (обязательно)
//   ALLOWED_ORIGINS   — с каких сайтов разрешены запросы, через запятую
//                       (по умолчанию https://serg1306.github.io)
//   PLATE_PER_DEVICE  — проверок в день с одного устройства (5)
//   PLATE_PER_IP      — проверок в день с одного IP (10)
//   PLATE_TOTAL       — проверок в день на один экземпляр функции (200)
// Точка входа: index.handler

const API = "https://api-cloud.ru/api";
const LAT_TO_CYR = { A: "А", B: "В", E: "Е", K: "К", M: "М", H: "Н", O: "О", P: "Р", C: "С", T: "Т", Y: "У", X: "Х" };
const PLATE_RE = /^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}$/;

function normalizePlate(raw) {
  const s = String(raw ?? "")
    .toUpperCase()
    .replace(/[\s\-_.|]/g, "")
    .replace(/RUS$/, "")
    .replace(/[ABEKMHOPCTYX]/g, (c) => LAT_TO_CYR[c] ?? c)
    .replace(/Ё/g, "Е");
  return PLATE_RE.test(s) ? s : null;
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v, d) => (v && /^\d+$/.test(v) ? parseInt(v, 10) : d);

async function call(method, params, token) {
  const url = new URL(`${API}/${method}.php`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Ключ передаём заголовком, чтобы он не попадал в журналы адресов
  const r = await fetch(url, { headers: { Token: token, Accept: "application/json" }, signal: AbortSignal.timeout(110_000) });
  const d = await r.json().catch(() => null);
  if (!d) throw new ApiError("сервис проверки вернул непонятный ответ", 502);
  const err = str(d.error);
  if (err) {
    const text = str(d.message) + " " + str(d.errormsg) + " " + err;
    if (err === "498" || /BALANCE|FUNDS/i.test(text)) throw new ApiError("на счёте сервиса проверки закончились деньги", 503);
    if (/TOKEN/i.test(text)) throw new ApiError("неверный ключ сервиса проверки (API_CLOUD_TOKEN)", 500);
    if (err === "TIME_MAX_CONNECT") throw new ApiError("база не ответила вовремя, попробуйте через пару минут", 504);
    throw new ApiError("ошибка сервиса проверки: " + (str(d.errormsg) || str(d.message) || err), 502);
  }
  return d;
}

const optional = (p) => p.catch(() => null);

async function lookupPlate(plate, token) {
  const conv = await call("converter", { type: "search", string: plate }, token);
  const partner = conv.partner ?? {};
  const r = partner.result ?? {};
  const vin = str(r.vin).toUpperCase();
  if (partner.found !== true || (!vin && !str(r.body))) return { plate, found: false };
  const out = { plate, found: true, make: str(r.brand), model: str(r.model), year: str(r.year), vin: vin || undefined, body: str(r.body) || undefined };
  const id = vin || str(r.body);
  const [dtp, wanted, restrict] = await Promise.all([
    optional(call("gibdd", { type: "dtp", vin: id }, token)),
    optional(call("gibdd", { type: "wanted", vin: id }, token)),
    optional(call("gibdd", { type: "restrict", vin: id }, token)),
  ]);
  out.dtp = dtp ? arr(dtp.records).map((x) => ({ date: str(x.AccidentDateTime), type: str(x.AccidentType), damage: str(x.VehicleDamageState) })) : null;
  out.wanted = wanted ? arr(wanted.records).length > 0 : null;
  // Поле phone в ограничениях — телефон ведомства, а не владельца; не передаём, чтобы не путать
  out.restrictions = restrict
    ? arr(restrict.records).map((x) => ({ type: str(x.ogrkodinfo), date: str(x.dateogr), who: str(x.divtypeinfo), reason: str(x.osnOgr).slice(0, 300) }))
    : null;
  return out;
}

// Дневные лимиты в памяти экземпляра функции. Это защита от случайного перерасхода;
// настоящий потолок расходов — баланс на api-cloud.ru.
const counts = new Map();
let countsDay = "";
const today = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10); // по Москве
function takeLimits(limits) {
  const day = today();
  if (day !== countsDay) { counts.clear(); countsDay = day; }
  for (const l of limits) if ((counts.get(l.key) || 0) >= l.max) return l;
  for (const l of limits) counts.set(l.key, (counts.get(l.key) || 0) + 1);
  return null;
}
function refundLimits(limits) {
  for (const l of limits) counts.set(l.key, Math.max((counts.get(l.key) || 1) - 1, 0));
}

function header(headers, name) {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === want) return String(v);
  return "";
}

function corsHeaders(origin) {
  const allowed = (process.env.ALLOWED_ORIGINS || "https://serg1306.github.io").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = origin && (allowed.includes(origin) || origin.startsWith("http://localhost"));
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Device-Id",
    Vary: "Origin",
  };
}

module.exports.handler = async function (event) {
  const headers = corsHeaders(header(event.headers, "Origin"));
  const reply = (body, statusCode) => ({
    statusCode,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  });
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return reply({ error: "Используйте POST" }, 405);

  const token = process.env.API_CLOUD_TOKEN;
  if (!token) return reply({ error: "Поиск по госномеру ещё не подключён", notConfigured: true }, 503);

  let body = null;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";
    body = JSON.parse(raw);
  } catch { /* неверный JSON */ }
  const plate = normalizePlate(body?.plate);
  if (!plate) return reply({ error: "Введите номер как на табличке, например А123ВС77 или А123ВС777" }, 400);

  const device = header(event.headers, "X-Device-Id").replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
  const ip = event.requestContext?.identity?.sourceIp || header(event.headers, "X-Forwarded-For").split(",")[0].trim() || "unknown";
  const limits = [
    { key: "ip:" + ip, max: num(process.env.PLATE_PER_IP, 10) },
    { key: "total", max: num(process.env.PLATE_TOTAL, 200) },
  ];
  if (device) limits.unshift({ key: "device:" + device, max: num(process.env.PLATE_PER_DEVICE, 5) });
  const blocked = takeLimits(limits);
  if (blocked) {
    const msg = blocked.key === "total"
      ? "Сегодня проверки по госномеру закончились на всём сервисе. Попробуйте завтра."
      : "На сегодня проверки по госномеру закончились. Попробуйте завтра.";
    return reply({ error: msg, limit: true }, 429);
  }
  try {
    return reply(await lookupPlate(plate, token), 200);
  } catch (e) {
    refundLimits(limits);
    return reply({ error: "Не удалось проверить номер: " + (e?.message || "ошибка") }, e instanceof ApiError ? e.status : 502);
  }
};

module.exports.normalizePlate = normalizePlate;
