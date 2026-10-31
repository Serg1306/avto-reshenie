// Сервер ИИ «АвтоРешение» (Cloudflare Worker).
// Два режима:
//  - "diagnose" (по умолчанию): машина + проблема + коды ошибок + фото + найденные видео
//    → поиск по форумам и бюллетеням → сводка: причины, что проверить, цена ремонта.
//  - "estimate": смета или счёт автосервиса (текст и/или фото) → сравнение с типичными ценами.
// Поиск в интернете делает встроенный веб-поиск Claude, ответ приходит в JSON на русском.
import Anthropic from "@anthropic-ai/sdk";
import { Limiter, type Limit } from "./limiter";

export { Limiter };

export interface Env {
  ANTHROPIC_API_KEY: string; // секрет: wrangler secret put ANTHROPIC_API_KEY
  ALLOWED_ORIGINS: string; // через запятую, например https://serg1306.github.io
  ANTHROPIC_BASE_URL?: string; // только для локальных тестов
  LIMITER: DurableObjectNamespace<Limiter>;
  FREE_PER_DEVICE?: string; // бесплатных запросов с одного устройства за всё время
  LIMIT_PER_IP?: string; // в день с одного IP (защита от подмены id устройства)
  LIMIT_TOTAL?: string; // всего в день на весь сервис (потолок расходов)
}

const num = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? parseInt(v, 10) : d);
// День считаем по московскому времени, чтобы лимит обновлялся в полночь по Москве
const today = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);

interface ImageIn {
  media_type: string;
  data: string; // base64 без префикса data:
}

interface RequestBody {
  mode?: "diagnose" | "estimate";
  make?: string;
  model?: string;
  year?: string;
  city?: string;
  problem?: string;
  codes?: string[];
  estimate?: string;
  images?: ImageIn[];
  videos?: { title: string; channel?: string; url: string }[];
}

type Block = Anthropic.Beta.Messages.BetaContentBlockParam;

const DIAGNOSE_SYSTEM = `Ты опытный автомеханик-диагност. Владелец описывает проблему с машиной, иногда прикладывает коды ошибок и фото.
Найди в интернете, что пишут об этой проблеме владельцы и механики именно этой модели:
форумы (drive2.ru, forums.drom.ru, клубные форумы, reddit), сервисные бюллетени (TSB) и отзывные кампании.
Сделай 2-5 поисков, на русском и на английском. Если есть фото, опиши, что на нём видно и что это значит.
Если есть коды ошибок, расшифруй каждый для этой машины.

Ответ дай ТОЛЬКО одним JSON-объектом без пояснений до или после, по схеме:
{
  "summary": "2-3 предложения: что это скорее всего и насколько срочно",
  "urgency": "можно ездить" | "ехать в сервис в ближайшее время" | "не ездить, опасно",
  "codes": [{"code": "P0300", "meaning": "что означает для этой машины"}],
  "photo": "что видно на фото, или пустая строка",
  "causes": [{"cause": "причина", "likelihood": "высокая" | "средняя" | "низкая", "check": "как проверить", "cost": "примерная стоимость ремонта в рублях, диапазон"}],
  "diy": ["что владелец может проверить сам, по шагам"],
  "recalls": "известные отзывные кампании или бюллетени по этой проблеме, либо пустая строка",
  "sources": [{"title": "название", "url": "ссылка"}]
}
Причин от 2 до 5, от самой вероятной. Цены в рублях для указанного города, если он есть, иначе по России.
Пиши по-русски, просто и без жаргона. Не выдумывай ссылки: в sources только страницы, которые ты действительно нашёл.
Если описание слишком расплывчатое, всё равно дай самые частые причины и в summary попроси уточнить симптомы.`;

const ESTIMATE_SYSTEM = `Ты независимый эксперт по стоимости автосервиса. Владелец показывает смету или счёт автосервиса (текстом или фото).
Разбери каждую позицию: работы и запчасти. Найди в интернете типичные цены на эти работы и запчасти для этой машины
в указанном городе (или по России): прайсы автосервисов, магазины запчастей, обсуждения на форумах. Сделай 2-5 поисков.
Проверь также, нужны ли эти работы при описанной проблеме и нет ли лишних позиций.

Ответ дай ТОЛЬКО одним JSON-объектом без пояснений до или после, по схеме:
{
  "verdict": "цена в норме" | "немного завышена" | "сильно завышена" | "подозрительно дёшево",
  "summary": "2-3 предложения: общий вывод и примерная справедливая сумма",
  "quoted_total": "сумма по смете в рублях, если её можно понять, иначе пустая строка",
  "fair_total": "справедливая сумма в рублях, диапазон",
  "items": [{"name": "позиция", "quoted": "цена в смете", "typical": "типичная цена, диапазон", "comment": "в норме / завышено / лишнее и почему"}],
  "questions": ["что спросить у сервиса перед оплатой"],
  "sources": [{"title": "название", "url": "ссылка"}]
}
Пиши по-русски, просто. Не выдумывай ссылки. Если смету не удаётся прочитать, скажи об этом в summary.`;

const MAX_IMAGES = 3;
const MAX_IMAGE_BASE64 = 2_000_000; // ~1.5 МБ на картинку
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

function cors(origin: string | null, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = origin && (allowed.includes(origin) || origin.startsWith("http://localhost"));
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Device-Id",
    "Access-Control-Expose-Headers": "X-Remaining",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

const clean = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function imageBlocks(images: ImageIn[] | undefined): Block[] | string {
  const list = (images ?? []).slice(0, MAX_IMAGES);
  const blocks: Block[] = [];
  for (const img of list) {
    const type = IMAGE_TYPES.find((t) => t === img?.media_type);
    if (!type || typeof img.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(img.data)) return "Фото в неподдерживаемом формате";
    if (img.data.length > MAX_IMAGE_BASE64) return "Фото слишком большое";
    blocks.push({ type: "image", source: { type: "base64", media_type: type, data: img.data } });
  }
  return blocks;
}

async function askClaude(client: Anthropic, system: string, content: Block[]) {
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content }];
  const found: { title: string; url: string }[] = [];
  let response: Anthropic.Beta.Messages.BetaMessage | undefined;
  // Веб-поиск выполняется на стороне Anthropic; pause_turn означает «продолжить с того же места»
  for (let i = 0; i < 3; i++) {
    response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      system,
      messages,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    for (const block of response.content) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) if (r.type === "web_search_result") found.push({ title: r.title, url: r.url });
      }
    }
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content as Block[] });
  }
  if (!response) throw new Error("пустой ответ");
  if (response.stop_reason === "refusal") return { refused: true as const };

  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  const match = text.match(/\{[\s\S]*\}/);
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(match ? match[0] : text);
  } catch {
    result = { summary: text };
  }
  const sources = Array.isArray(result.sources) && result.sources.length ? result.sources : found.slice(0, 8);
  return { refused: false as const, result: { ...result, sources } };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = cors(request.headers.get("Origin"), env);
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method !== "POST") return json({ error: "Используйте POST" }, 405, headers);

    let body: RequestBody;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Неверный формат запроса" }, 400, headers);
    }
    const mode = body.mode === "estimate" ? "estimate" : "diagnose";
    const car = [clean(body.make, 40), clean(body.model, 60), clean(body.year, 4)].filter(Boolean).join(" ");
    const city = clean(body.city, 60);
    const problem = clean(body.problem, 600);
    const codes = (Array.isArray(body.codes) ? body.codes : [])
      .map((c) => clean(c, 8).toUpperCase())
      .filter((c) => /^[PBCU][0-9A-F]{4}$/.test(c))
      .slice(0, 10);
    const images = imageBlocks(body.images);
    if (typeof images === "string") return json({ error: images }, 400, headers);

    let system: string;
    let text: string;
    if (mode === "diagnose") {
      if (!car || (!problem && !codes.length && !images.length)) {
        return json({ error: "Укажите машину и опишите проблему, код ошибки или приложите фото" }, 400, headers);
      }
      const videos = (body.videos ?? []).slice(0, 15)
        .map((v) => `- ${clean(v.title, 150)} (${clean(v.channel, 60)})`).join("\n");
      system = DIAGNOSE_SYSTEM;
      text = `Машина: ${car}` + (city ? `\nГород: ${city}` : "") +
        (problem ? `\nПроблема: ${problem}` : "") +
        (codes.length ? `\nКоды ошибок: ${codes.join(", ")}` : "") +
        (images.length ? `\nПриложено фото: ${images.length}` : "") +
        (videos ? `\n\nНа YouTube по этой проблеме нашлись видео:\n${videos}` : "");
    } else {
      const estimate = clean(body.estimate, 4000);
      if (!estimate && !images.length) return json({ error: "Вставьте текст сметы или приложите её фото" }, 400, headers);
      system = ESTIMATE_SYSTEM;
      text = `Машина: ${car || "не указана"}` + (city ? `\nГород: ${city}` : "") +
        (problem ? `\nС какой проблемой обратились: ${problem}` : "") +
        (estimate ? `\n\nСмета:\n${estimate}` : "\n\nСмета на фото.");
    }

    // Лимиты: бесплатные попытки устройства (за всё время), IP в день и общий дневной потолок
    const device = clean(request.headers.get("X-Device-Id"), 64).replace(/[^A-Za-z0-9-]/g, "");
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const free = num(env.FREE_PER_DEVICE, 3);
    const limits: Limit[] = [
      { key: "device:" + (device || "ip-" + ip), max: free, lifetime: true },
      { key: "ip:" + ip, max: num(env.LIMIT_PER_IP, 15) },
      { key: "total", max: num(env.LIMIT_TOTAL, 100) },
    ];
    const day = today();
    const limiter = env.LIMITER.get(env.LIMITER.idFromName("global"));
    const taken = await limiter.take(day, limits);
    if (!taken.ok) {
      const msg = taken.blocked === "total"
        ? "Сегодня сервис исчерпал дневной запас ИИ-запросов. Попробуйте завтра."
        : taken.blocked === "ip"
          ? "Слишком много запросов с вашей сети сегодня. Попробуйте завтра."
          : `Бесплатные попытки закончились (${free} из ${free}). Дальше ИИ-сводка доступна по подписке.`;
      return json({ error: msg, limit: true, paywall: taken.blocked === "device" }, 429, { ...headers, "X-Remaining": "0" });
    }
    const limitHeaders = { ...headers, "X-Remaining": String(taken.remaining) };
    const refund = () => limiter.refund(day, limits);

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined });
    try {
      const out = await askClaude(client, system, [...images, { type: "text", text }]);
      if (out.refused) {
        await refund();
        return json({ error: "ИИ не смог ответить на этот запрос. Попробуйте описать иначе." }, 422, limitHeaders);
      }
      return json({ mode, ...out.result, remaining: taken.remaining }, 200, limitHeaders);
    } catch (err) {
      await refund();
      if (err instanceof Anthropic.RateLimitError) {
        return json({ error: "Слишком много запросов, попробуйте через минуту" }, 429, headers);
      }
      if (err instanceof Anthropic.AuthenticationError) {
        return json({ error: "Сервер настроен неверно: проверьте ключ ANTHROPIC_API_KEY" }, 500, headers);
      }
      if (err instanceof Anthropic.APIError) {
        return json({ error: "Ошибка ИИ-сервиса: " + err.message }, 502, headers);
      }
      return json({ error: "Не удалось получить ответ" }, 500, headers);
    }
  },
} satisfies ExportedHandler<Env>;
