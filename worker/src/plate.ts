// Поиск машины по госномеру через api-cloud.ru (https://api-cloud.ru).
// 1) Конвертер «госномер → VIN»: марка, модель, год, VIN, номер кузова.
// 2) По VIN параллельно: ДТП, розыск и ограничения (данные Госавтоинспекции).
// Данные владельца (ФИО, телефон, адрес) не запрашиваются и не отдаются: это персональные данные (152-ФЗ).

const API = "https://api-cloud.ru/api";

// Буквы, которые бывают на российских номерах. Латиница заменяется на такую же кириллицу.
const LAT_TO_CYR: Record<string, string> = { A: "А", B: "В", E: "Е", K: "К", M: "М", H: "Н", O: "О", P: "Р", C: "С", T: "Т", Y: "У", X: "Х" };
// Обычный номер легковой машины: А123ВС77 или А123ВС777
const PLATE_RE = /^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}$/;

export function normalizePlate(raw: unknown): string | null {
  const s = String(raw ?? "")
    .toUpperCase()
    .replace(/[\s\-_.|]/g, "")
    .replace(/RUS$/, "")
    .replace(/[ABEKMHOPCTYX]/g, (c) => LAT_TO_CYR[c] ?? c)
    .replace(/Ё/g, "Е");
  return PLATE_RE.test(s) ? s : null;
}

export interface PlateResult {
  plate: string;
  found: boolean;
  make?: string;
  model?: string;
  year?: string;
  vin?: string;
  body?: string;
  dtp?: { date: string; type: string; damage: string }[] | null;
  wanted?: boolean | null;
  restrictions?: { type: string; date: string; who: string; reason: string }[] | null;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

async function call(method: string, params: Record<string, string>, token: string): Promise<Json> {
  const url = new URL(`${API}/${method}.php`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Ключ передаём заголовком, чтобы он не попадал в журналы адресов
  const r = await fetch(url.toString(), { headers: { Token: token, Accept: "application/json" } });
  const d = (await r.json().catch(() => null)) as Json | null;
  if (!d) throw new ApiError("сервис проверки вернул непонятный ответ", 502);
  const err = str(d.error);
  if (err) {
    if (err === "498" || /BALANCE|FUNDS/i.test(str(d.message) + err)) throw new ApiError("на счёте сервиса проверки закончились деньги", 503);
    if (/TOKEN/i.test(str(d.message) + str(d.errormsg) + err)) throw new ApiError("неверный ключ сервиса проверки (API_CLOUD_TOKEN)", 500);
    if (err === "TIME_MAX_CONNECT") throw new ApiError("база не ответила вовремя, попробуйте через пару минут", 504);
    throw new ApiError("ошибка сервиса проверки: " + (str(d.errormsg) || str(d.message) || err), 502);
  }
  return d;
}

// Отдельные проверки по VIN необязательны: если какая-то не ответила, вернём null вместо неё
async function optional<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export async function lookupPlate(plate: string, token: string): Promise<PlateResult> {
  const conv = await call("converter", { type: "search", string: plate }, token);
  const partner = (conv.partner ?? {}) as Json;
  const r = (partner.result ?? {}) as Json;
  const vin = str(r.vin).toUpperCase();
  if (partner.found !== true || (!vin && !str(r.body))) return { plate, found: false };

  const out: PlateResult = {
    plate,
    found: true,
    make: str(r.brand),
    model: str(r.model),
    year: str(r.year),
    vin: vin || undefined,
    body: str(r.body) || undefined,
  };
  const id = vin || str(r.body);

  const [dtp, wanted, restrict] = await Promise.all([
    optional(call("gibdd", { type: "dtp", vin: id }, token)),
    optional(call("gibdd", { type: "wanted", vin: id }, token)),
    optional(call("gibdd", { type: "restrict", vin: id }, token)),
  ]);

  out.dtp = dtp
    ? arr(dtp.records).map((x) => ({
        date: str(x.AccidentDateTime),
        type: str(x.AccidentType),
        damage: str(x.VehicleDamageState),
      }))
    : null;
  out.wanted = wanted ? arr(wanted.records).length > 0 : null;
  // Поле phone в ограничениях — это телефон ведомства, наложившего запрет; его не передаём, чтобы не путать с владельцем
  out.restrictions = restrict
    ? arr(restrict.records).map((x) => ({
        type: str(x.ogrkodinfo),
        date: str(x.dateogr),
        who: str(x.divtypeinfo),
        reason: str(x.osnOgr).slice(0, 300),
      }))
    : null;
  return out;
}
