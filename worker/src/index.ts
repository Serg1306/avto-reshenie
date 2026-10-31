// Сервер ИИ-сводки «АвтоРешение» (Cloudflare Worker).
// Принимает машину, описание проблемы и найденные видео, ищет в интернете
// (форумы, бортжурналы, сервисные бюллетени) через встроенный веб-поиск Claude
// и возвращает сводку на русском в формате JSON.
import Anthropic from "@anthropic-ai/sdk";

export interface Env {
  ANTHROPIC_API_KEY: string; // секрет: wrangler secret put ANTHROPIC_API_KEY
  ALLOWED_ORIGINS: string; // через запятую, например https://serg1306.github.io
  ANTHROPIC_BASE_URL?: string; // только для локальных тестов
}

interface SummaryRequest {
  make?: string;
  model?: string;
  year?: string;
  problem?: string;
  videos?: { title: string; channel?: string; url: string }[];
}

const SYSTEM = `Ты опытный автомеханик-диагност. Владелец описывает проблему с машиной.
Найди в интернете, что пишут об этой проблеме владельцы и механики именно этой модели:
форумы (drive2.ru, forums.drom.ru, клубные форумы, reddit), сервисные бюллетени (TSB) и отзывные кампании.
Сделай 2-5 поисков, на русском и на английском.

Ответ дай ТОЛЬКО одним JSON-объектом без пояснений до или после, по схеме:
{
  "summary": "2-3 предложения: что это скорее всего и насколько срочно",
  "urgency": "можно ездить" | "ехать в сервис в ближайшее время" | "не ездить, опасно",
  "causes": [{"cause": "причина", "likelihood": "высокая" | "средняя" | "низкая", "check": "как проверить", "cost": "примерная стоимость ремонта в рублях, диапазон"}],
  "diy": ["что владелец может проверить сам, по шагам"],
  "recalls": "известные отзывные кампании или бюллетени по этой проблеме, либо пустая строка",
  "sources": [{"title": "название", "url": "ссылка"}]
}
Причин от 2 до 5, от самой вероятной. Пиши по-русски, просто и без жаргона.
Не выдумывай ссылки: в sources только страницы, которые ты действительно нашёл.
Если описание слишком расплывчатое, всё равно дай самые частые причины и в summary попроси уточнить симптомы.`;

function cors(origin: string | null, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = origin && (allowed.includes(origin) || origin.startsWith("http://localhost"));
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = cors(request.headers.get("Origin"), env);
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method !== "POST") return json({ error: "Используйте POST" }, 405, headers);

    let body: SummaryRequest;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Неверный формат запроса" }, 400, headers);
    }
    const car = [clean(body.make, 40), clean(body.model, 60), clean(body.year, 4)].filter(Boolean).join(" ");
    const problem = clean(body.problem, 600);
    if (!car || !problem) return json({ error: "Укажите машину и проблему" }, 400, headers);

    const videos = (body.videos ?? []).slice(0, 15)
      .map((v) => `- ${clean(v.title, 150)} (${clean(v.channel, 60)})`).join("\n");
    const userText = `Машина: ${car}\nПроблема: ${problem}` +
      (videos ? `\n\nНа YouTube по этой проблеме нашлись видео:\n${videos}` : "");

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined });
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: userText }];

    try {
      let response: Anthropic.Beta.Messages.BetaMessage | undefined;
      // Все найденные страницы, на случай если модель не перечислила источники
      const found: { title: string; url: string }[] = [];
      // Веб-поиск выполняется на стороне Anthropic; pause_turn означает «продолжить с того же места»
      for (let i = 0; i < 3; i++) {
        response = await client.beta.messages.create({
          model: "claude-opus-5-5",
          max_tokens: 16000,
          system: SYSTEM,
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
        messages.push({ role: "assistant", content: response.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });
      }
      if (!response) throw new Error("пустой ответ");
      if (response.stop_reason === "refusal") {
        return json({ error: "ИИ не смог ответить на этот запрос. Попробуйте описать проблему иначе." }, 422, headers);
      }

      const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      const match = text.match(/\{[\s\S]*\}/);
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(match ? match[0] : text);
      } catch {
        result = { summary: text, causes: [], diy: [], recalls: "", sources: [] };
      }
      const sources = Array.isArray(result.sources) && result.sources.length ? result.sources : found.slice(0, 8);
      return json({ ...result, sources }, 200, headers);
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        return json({ error: "Слишком много запросов, попробуйте через минуту" }, 429, headers);
      }
      if (err instanceof Anthropic.AuthenticationError) {
        return json({ error: "Сервер настроен неверно: проверьте ключ ANTHROPIC_API_KEY" }, 500, headers);
      }
      if (err instanceof Anthropic.APIError) {
        return json({ error: "Ошибка ИИ-сервиса: " + err.message }, 502, headers);
      }
      return json({ error: "Не удалось получить сводку" }, 500, headers);
    }
  },
} satisfies ExportedHandler<Env>;
