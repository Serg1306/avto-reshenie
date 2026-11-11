// ИИ-сводка «АвтоРешение» на YandexGPT (Яндекс Облако, Cloud Functions, Node.js 22, без сторонних библиотек).
// Режимы (как у прежнего сервера, сайт ничего не замечает):
//  - "diagnose": машина + проблема + коды + фото → поиск в Яндексе по форумам → сводка: причины, что проверить, цена;
//  - "estimate": смета автосервиса (текст и/или фото) → сравнение с типичными ценами.
// Фото: текст с них распознаёт Yandex Vision OCR (YandexGPT сам картинки не видит).
// Бесплатные попытки и дневные лимиты хранятся в бакете Object Storage.
//
// Адреса (одна ссылка функции):
//   POST <ссылка>                  — сводка или проверка счёта
//   GET  <ссылка>?action=status    — сколько бесплатных попыток осталось
//
// Переменные окружения:
//   FOLDER_ID        — ID каталога Яндекс Облака (обязательно)
//   BUCKET           — имя бакета Object Storage для счётчиков (обязательно)
//   YANDEX_MODEL     — модель, по умолчанию yandexgpt-5.1 (YandexGPT Pro 5.1)
//   ALLOWED_ORIGINS  — сайты, с которых разрешены запросы (по умолчанию https://serg1306.github.io)
//   FREE_PER_DEVICE  — бесплатных сводок на устройство за всё время (3)
//   LIMIT_PER_IP     — сводок в день с одного IP (15)
//   LIMIT_TOTAL      — сводок в день на весь сервис (100)
// Доступ: функции назначается сервисный аккаунт с ролями ai.languageModels.user,
// search-api.webSearch.user, ai.vision.user и storage.editor. Ключи хранить не нужно.

const MAX_IMAGES = 3;
const MAX_IMAGE_BASE64 = 2_000_000;

const DIAGNOSE_SYSTEM = `Ты опытный автомеханик-диагност. Владелец описывает проблему с машиной, иногда прикладывает коды ошибок и текст, распознанный с фото.
Ниже даны результаты поиска в интернете (форумы, статьи). Опирайся на них и на свои знания о конкретной модели.
Если есть коды ошибок, расшифруй каждый для этой машины.

Ответ дай ТОЛЬКО одним JSON-объектом по схеме:
{
  "summary": "2-3 предложения: что это скорее всего и насколько срочно",
  "urgency": "можно ездить" | "ехать в сервис в ближайшее время" | "не ездить, опасно",
  "codes": [{"code": "P0300", "meaning": "что означает для этой машины"}],
  "photo": "что следует из текста с фото, или пустая строка",
  "causes": [{"cause": "причина", "likelihood": "высокая" | "средняя" | "низкая", "check": "как проверить", "cost": "примерная стоимость ремонта в рублях, диапазон"}],
  "diy": ["что владелец может проверить сам, по шагам"],
  "recalls": "известные отзывные кампании или бюллетени по этой проблеме, либо пустая строка",
  "sources": [{"title": "название", "url": "ссылка"}]
}
Причин от 2 до 5, от самой вероятной. Цены в рублях для указанного города, если он есть, иначе по России.
Пиши по-русски, просто и без жаргона. В sources указывай только ссылки из результатов поиска ниже, не выдумывай.
Если описание слишком расплывчатое, всё равно дай самые частые причины и в summary попроси уточнить симптомы.`;

const ESTIMATE_SYSTEM = `Ты независимый эксперт по стоимости автосервиса. Владелец показывает смету или счёт автосервиса (текстом или распознанным с фото).
Разбери каждую позицию: работы и запчасти. Ниже даны результаты поиска цен в интернете; опирайся на них и на свои знания цен в России.
Проверь также, нужны ли эти работы при описанной проблеме и нет ли лишних позиций.

Ответ дай ТОЛЬКО одним JSON-объектом по схеме:
{
  "verdict": "цена в норме" | "немного завышена" | "сильно завышена" | "подозрительно дёшево",
  "summary": "2-3 предложения: общий вывод и примерная справедливая сумма",
  "quoted_total": "сумма по смете в рублях, если её можно понять, иначе пустая строка",
  "fair_total": "справедливая сумма в рублях, диапазон",
  "items": [{"name": "позиция", "quoted": "цена в смете", "typical": "типичная цена, диапазон", "comment": "в норме / завышено / лишнее и почему"}],
  "questions": ["что спросить у сервиса перед оплатой"],
  "sources": [{"title": "название", "url": "ссылка"}]
}
Пиши по-русски, просто. В sources только ссылки из результатов поиска ниже. Если смету не удаётся прочитать, скажи об этом в summary.`;

const num = (v, d) => (v && /^\d+$/.test(v) ? parseInt(v, 10) : d);
const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const today = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10); // по Москве

class HttpError extends Error {
  constructor(message, status, extra) { super(message); this.status = status; this.extra = extra; }
}

// --- Доступ к API Яндекс Облака ---
function authHeaders(ctx) {
  const token = ctx?.token?.access_token;
  if (!token) throw new HttpError("Функции не назначен сервисный аккаунт (см. инструкцию)", 500);
  return { Authorization: "Bearer " + token, "x-folder-id": process.env.FOLDER_ID || "" };
}

async function postJson(url, body, ctx, timeoutMs = 60_000) {
  const r = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = d?.error?.message || d?.message || "код " + r.status;
    if (r.status === 401 || r.status === 403) throw new HttpError("нет доступа к сервису Яндекса, проверьте роли сервисного аккаунта: " + msg, 500);
    if (r.status === 429) throw new HttpError("Слишком много запросов, попробуйте через минуту", 429);
    throw new HttpError("ошибка сервиса Яндекса: " + msg, 502);
  }
  return d;
}

// --- Счётчики в Object Storage (IAM-токен функции в заголовке X-YaCloud-SubjectToken) ---
const storageUrl = (key) => `https://storage.yandexcloud.net/${process.env.BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
async function getCount(ctx, key) {
  const r = await fetch(storageUrl(key), { headers: { "X-YaCloud-SubjectToken": ctx.token.access_token } });
  if (r.status === 404) return 0;
  if (!r.ok) throw new HttpError("не удалось прочитать счётчик попыток (проверьте бакет и роль storage.editor)", 500);
  return num((await r.text()).trim(), 0);
}
async function setCount(ctx, key, n) {
  const r = await fetch(storageUrl(key), {
    method: "PUT",
    headers: { "X-YaCloud-SubjectToken": ctx.token.access_token, "Content-Type": "text/plain" },
    body: String(Math.max(n, 0)),
  });
  if (!r.ok) throw new HttpError("не удалось сохранить счётчик попыток", 500);
}

function plan(device, ip) {
  const day = today();
  return {
    free: num(process.env.FREE_PER_DEVICE, 3),
    deviceKey: `free/${device}`,
    daily: [
      { key: `day/${day}/ip-${ip}`, max: num(process.env.LIMIT_PER_IP, 15), kind: "ip" },
      { key: `day/${day}/total`, max: num(process.env.LIMIT_TOTAL, 100), kind: "total" },
    ],
  };
}

async function take(ctx, p) {
  const daily = await Promise.all(p.daily.map((l) => getCount(ctx, l.key)));
  for (let i = 0; i < p.daily.length; i++) if (daily[i] >= p.daily[i].max) return { ok: false, blocked: p.daily[i].kind };
  const used = await getCount(ctx, p.deviceKey);
  if (used >= p.free) return { ok: false, blocked: "free" };
  await Promise.all([setCount(ctx, p.deviceKey, used + 1), ...p.daily.map((l, i) => setCount(ctx, l.key, daily[i] + 1))]);
  return { ok: true, remaining: p.free - used - 1 };
}

async function refund(ctx, p) {
  try {
    const keys = [p.deviceKey, ...p.daily.map((l) => l.key)];
    const vals = await Promise.all(keys.map((k) => getCount(ctx, k)));
    await Promise.all(keys.map((k, i) => setCount(ctx, k, vals[i] - 1)));
  } catch { /* не страшно */ }
}

// --- Яндекс Поиск ---
const decodeXml = (s) => s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function parseSearchXml(xml) {
  const docs = [];
  for (const m of xml.matchAll(/<doc\b[^>]*>([\s\S]*?)<\/doc>/g)) {
    const d = m[1];
    const url = decodeXml((d.match(/<url>([\s\S]*?)<\/url>/) || [])[1] || "");
    const title = decodeXml((d.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const passages = [...d.matchAll(/<passage>([\s\S]*?)<\/passage>/g)].map((p) => decodeXml(p[1])).join(" … ");
    const headline = decodeXml((d.match(/<headline>([\s\S]*?)<\/headline>/) || [])[1] || "");
    if (url) docs.push({ url, title: title || url, text: (passages || headline).slice(0, 600) });
  }
  return docs;
}

async function webSearch(ctx, queryText) {
  const d = await postJson("https://searchapi.api.cloud.yandex.net/v2/web/search", {
    query: { searchType: "SEARCH_TYPE_RU", queryText: queryText.slice(0, 400) },
    folderId: process.env.FOLDER_ID,
    responseFormat: "FORMAT_XML",
    groupSpec: { groupMode: "GROUP_MODE_DEEP", groupsOnPage: "6", docsInGroup: "1" },
    maxPassages: "3",
    l10n: "LOCALIZATION_RU",
  }, ctx, 20_000);
  return parseSearchXml(Buffer.from(d.rawData || "", "base64").toString("utf8"));
}

async function searchAll(ctx, queries) {
  const lists = await Promise.all(queries.map((q) => webSearch(ctx, q).catch(() => [])));
  const seen = new Set();
  const out = [];
  for (const list of lists) for (const doc of list) {
    if (seen.has(doc.url)) continue;
    seen.add(doc.url);
    out.push(doc);
  }
  return out.slice(0, 10);
}

// --- Распознавание текста на фото ---
async function ocr(ctx, img) {
  const mime = img.media_type === "image/png" ? "PNG" : "JPEG";
  const d = await postJson("https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText", {
    mimeType: mime, languageCodes: ["ru", "en"], model: "page", content: img.data,
  }, ctx, 30_000);
  return clean((d.result || d).textAnnotation?.fullText, 3000);
}

// --- YandexGPT ---
async function askGpt(ctx, system, user) {
  const model = process.env.YANDEX_MODEL || "yandexgpt-5.1";
  const d = await postJson("https://ai.api.cloud.yandex.net/foundationModels/v1/completion", {
    modelUri: `gpt://${process.env.FOLDER_ID}/${model}`,
    completionOptions: { stream: false, temperature: 0.3, maxTokens: "4000" },
    jsonObject: true,
    messages: [{ role: "system", text: system }, { role: "user", text: user }],
  }, ctx, 90_000);
  const alt = (d.result || d).alternatives?.[0];
  if (!alt) throw new HttpError("пустой ответ нейросети", 502);
  if (alt.status === "ALTERNATIVE_STATUS_CONTENT_FILTER") return { refused: true };
  const text = String(alt.message?.text || "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  try {
    return { refused: false, result: JSON.parse(match ? match[0] : text) };
  } catch {
    return { refused: false, result: { summary: text } };
  }
}

// --- HTTP ---
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Device-Id",
    "Access-Control-Expose-Headers": "X-Remaining, X-Paid",
    Vary: "Origin",
  };
}

module.exports.handler = async function (event, ctx) {
  const cors = corsHeaders(header(event.headers, "Origin"));
  const reply = (body, statusCode, extra = {}) => ({
    statusCode,
    headers: { ...cors, ...extra, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  });
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  const device = header(event.headers, "X-Device-Id").replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
  const ip = event.requestContext?.identity?.sourceIp || "unknown";
  const p = plan(device || "ip-" + ip, ip);
  const action = String(event.queryStringParameters?.action || "").replace(/^\//, "");

  try {
    if (!process.env.FOLDER_ID || !process.env.BUCKET) throw new HttpError("Не заданы FOLDER_ID и BUCKET (см. инструкцию)", 500);
    authHeaders(ctx); // проверяем, что функции назначен сервисный аккаунт

    if (action === "status") {
      const used = await getCount(ctx, p.deviceKey);
      return reply({ freeLeft: Math.max(p.free - used, 0), paid: false, price: 300, perYear: 10, payments: false }, 200);
    }
    if (action.startsWith("pay")) return reply({ error: "Оплата ещё не подключена" }, 503);
    if (event.httpMethod !== "POST") return reply({ error: "Используйте POST" }, 405);

    let body = null;
    try {
      body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "");
    } catch { /* неверный JSON */ }
    if (!body) return reply({ error: "Неверный формат запроса" }, 400);

    const mode = body.mode === "estimate" ? "estimate" : "diagnose";
    const car = [clean(body.make, 40), clean(body.model, 60), clean(body.year, 4)].filter(Boolean).join(" ");
    const city = clean(body.city, 60);
    const problem = clean(body.problem, 600);
    const codes = (Array.isArray(body.codes) ? body.codes : []).map((c) => clean(c, 8).toUpperCase()).filter((c) => /^[PBCU][0-9A-F]{4}$/.test(c)).slice(0, 10);
    const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES);
    for (const img of images) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(img?.media_type) || typeof img.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(img.data)) return reply({ error: "Фото в неподдерживаемом формате" }, 400);
      if (img.data.length > MAX_IMAGE_BASE64) return reply({ error: "Фото слишком большое" }, 400);
    }
    const estimate = clean(body.estimate, 4000);
    if (mode === "diagnose" && (!car || (!problem && !codes.length && !images.length))) {
      return reply({ error: "Укажите машину и опишите проблему, код ошибки или приложите фото" }, 400);
    }
    if (mode === "estimate" && !estimate && !images.length) return reply({ error: "Вставьте текст сметы или приложите её фото" }, 400);

    const taken = await take(ctx, p);
    if (!taken.ok) {
      const msg = taken.blocked === "total"
        ? "Сегодня сервис исчерпал дневной запас ИИ-запросов. Попробуйте завтра."
        : taken.blocked === "ip"
          ? "Слишком много запросов с вашей сети сегодня. Попробуйте завтра."
          : `Бесплатные попытки закончились (${p.free} из ${p.free}). Дальше ИИ-сводка доступна по подписке.`;
      return reply({ error: msg, limit: true, paywall: taken.blocked === "free" }, 429, { "X-Remaining": "0" });
    }
    const limitHeaders = { "X-Remaining": String(taken.remaining), "X-Paid": "0" };

    try {
      // webp распознавание не берёт — такие фото пропускаем
      const photoText = (await Promise.all(images.filter((i) => i.media_type !== "image/webp").map((i) => ocr(ctx, i).catch(() => "")))).filter(Boolean).join("\n---\n");

      let system, text, queries;
      if (mode === "diagnose") {
        const videos = (Array.isArray(body.videos) ? body.videos : []).slice(0, 15).map((v) => `- ${clean(v?.title, 150)} (${clean(v?.channel, 60)})`).join("\n");
        const what = [problem, codes.join(" ")].filter(Boolean).join(" ");
        queries = [`${car} ${what}`, `${car} ${what} форум drive2`];
        system = DIAGNOSE_SYSTEM;
        text = `Машина: ${car}` + (city ? `\nГород: ${city}` : "") + (problem ? `\nПроблема: ${problem}` : "") +
          (codes.length ? `\nКоды ошибок: ${codes.join(", ")}` : "") +
          (photoText ? `\nТекст с фото:\n${photoText}` : images.length ? "\nФото приложено, но текста на нём нет." : "") +
          (videos ? `\n\nНа YouTube по этой проблеме нашлись видео:\n${videos}` : "");
      } else {
        const sm = (estimate || photoText).slice(0, 200);
        queries = [`${car} стоимость ремонта ${sm}`, `${car} цена запчасти ${sm}`];
        system = ESTIMATE_SYSTEM;
        text = `Машина: ${car || "не указана"}` + (city ? `\nГород: ${city}` : "") + (problem ? `\nС какой проблемой обратились: ${problem}` : "") +
          (estimate ? `\n\nСмета:\n${estimate}` : "") + (photoText ? `\n\nСмета (текст с фото):\n${photoText}` : "");
      }

      const found = await searchAll(ctx, queries);
      text += found.length
        ? "\n\nРезультаты поиска в интернете:\n" + found.map((d, i) => `[${i + 1}] ${d.title}\n${d.url}\n${d.text}`).join("\n\n")
        : "\n\nПоиск в интернете ничего не дал, отвечай по своим знаниям, sources оставь пустым.";

      const out = await askGpt(ctx, system, text);
      if (out.refused) {
        await refund(ctx, p);
        return reply({ error: "ИИ не смог ответить на этот запрос. Попробуйте описать иначе." }, 422, limitHeaders);
      }
      // Оставляем только ссылки, которые действительно нашлись
      const known = new Map(found.map((d) => [d.url, d.title]));
      const own = Array.isArray(out.result.sources) ? out.result.sources.filter((s) => s && known.has(s.url)) : [];
      const sources = own.length ? own : found.slice(0, 6).map((d) => ({ title: d.title, url: d.url }));
      return reply({ mode, ...out.result, sources, remaining: taken.remaining }, 200, limitHeaders);
    } catch (e) {
      await refund(ctx, p);
      throw e;
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return reply({ error: e instanceof HttpError ? e.message : "Не удалось получить ответ" }, status);
  }
};

module.exports.parseSearchXml = parseSearchXml;
