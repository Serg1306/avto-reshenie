// Интернет-эквайринг Т-Банка: создание платежа (Init) и проверка уведомлений.
// Подпись (Token): берутся только поля верхнего уровня (без вложенных объектов Receipt и DATA),
// добавляется Password, пары сортируются по ключу, значения склеиваются без разделителей,
// от строки считается SHA-256 в hex.

export interface TBankConfig {
  terminalKey: string;
  password: string;
  api: string; // https://securepay.tinkoff.ru/v2
}

type Flat = Record<string, unknown>;

export async function token(params: Flat, password: string): Promise<string> {
  const pairs: [string, string][] = Object.entries(params)
    .filter(([k, v]) => k !== "Token" && v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => [k, String(v)]);
  pairs.push(["Password", password]);
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const data = new TextEncoder().encode(pairs.map(([, v]) => v).join(""));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Постоянное время сравнения, чтобы не подсказывать подпись по времени ответа
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verify(notification: Flat, password: string): Promise<boolean> {
  const got = String(notification.Token ?? "").toLowerCase();
  return !!got && sameHex(got, await token(notification, password));
}

export interface InitParams {
  amountKopecks: number;
  orderId: string;
  description: string;
  email: string;
  notificationUrl: string;
  successUrl: string;
  failUrl: string;
  taxation: string; // система налогообложения ООО для чека, например usn_income
}

export async function init(cfg: TBankConfig, p: InitParams): Promise<{ paymentUrl: string; paymentId: string }> {
  const body: Flat = {
    TerminalKey: cfg.terminalKey,
    Amount: p.amountKopecks,
    OrderId: p.orderId,
    Description: p.description,
    NotificationURL: p.notificationUrl,
    SuccessURL: p.successUrl,
    FailURL: p.failUrl,
    // Чек по 54-ФЗ: отправляется покупателю на email
    Receipt: {
      Email: p.email,
      Taxation: p.taxation,
      Items: [{
        Name: p.description,
        Price: p.amountKopecks,
        Quantity: 1,
        Amount: p.amountKopecks,
        Tax: "none",
        PaymentMethod: "full_prepayment",
        PaymentObject: "service",
      }],
    },
  };
  body.Token = await token(body, cfg.password);
  const r = await fetch(cfg.api.replace(/\/$/, "") + "/Init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = (await r.json().catch(() => ({}))) as Flat;
  if (!r.ok || d.Success !== true || typeof d.PaymentURL !== "string") {
    throw new Error(String(d.Message || d.Details || "банк не создал платёж (код " + r.status + ")"));
  }
  return { paymentUrl: d.PaymentURL, paymentId: String(d.PaymentId ?? "") };
}
