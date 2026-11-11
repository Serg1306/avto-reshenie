// Учёт ИИ-запросов и подписок. Один экземпляр Durable Object на весь сервис,
// данные в SQLite: проверка и списание атомарны даже при одновременных запросах.
import { DurableObject } from "cloudflare:workers";

export interface Limit {
  key: string; // например "device:abc", "ip:1.2.3.4", "total"
  max: number;
  lifetime?: boolean; // true: лимит на всё время, иначе на текущий день
}

export interface Plan {
  free: number; // бесплатных попыток на устройство за всё время
  limits: Limit[]; // дневные защитные лимиты (IP, весь сервис)
}

export interface TakeResult {
  ok: boolean;
  blocked?: "free" | "ip" | "total";
  paid: boolean; // списано с подписки
  remaining: number; // осталось бесплатных или по подписке
  until?: number; // подписка действует до (мс)
}

export interface Status {
  freeLeft: number;
  paid: boolean;
  until?: number;
  left?: number;
  email?: string;
}

const LIFETIME = "all"; // вместо даты; "all" > любой даты, поэтому не удаляется очисткой
const YEAR_MS = 365 * 24 * 3600 * 1000;

export class Limiter extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, key))");
    // Подписка привязана к email: так её можно восстановить на другом устройстве,
    // а годовой запас сводок общий для всех устройств подписчика
    sql.exec("CREATE TABLE IF NOT EXISTS subs (email TEXT PRIMARY KEY, until INTEGER NOT NULL, left INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS devices (device TEXT PRIMARY KEY, email TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS orders (order_id TEXT PRIMARY KEY, device TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL)");
  }

  private count(day: string, key: string): number {
    const row = this.ctx.storage.sql.exec<{ n: number }>("SELECT n FROM counts WHERE day = ? AND key = ?", day, key).toArray()[0];
    return row ? row.n : 0;
  }

  private bump(day: string, key: string, delta: number): void {
    if (delta > 0) {
      this.ctx.storage.sql.exec(
        "INSERT INTO counts (day, key, n) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET n = n + ?",
        day, key, delta, delta,
      );
    } else {
      this.ctx.storage.sql.exec("UPDATE counts SET n = MAX(n + ?, 0) WHERE day = ? AND key = ?", delta, day, key);
    }
  }

  private sub(device: string): { email: string; until: number; left: number } | undefined {
    return this.ctx.storage.sql.exec<{ email: string; until: number; left: number }>(
      "SELECT s.email, s.until, s.left FROM devices d JOIN subs s ON s.email = d.email WHERE d.device = ?", device,
    ).toArray()[0];
  }

  status(device: string, free: number): Status {
    const used = this.count(LIFETIME, "device:" + device);
    const s = this.sub(device);
    const active = !!s && s.until > Date.now();
    return { freeLeft: Math.max(free - used, 0), paid: active, until: s?.until, left: active ? s!.left : undefined, email: s?.email };
  }

  // Списывает один запрос: сначала с подписки, иначе с бесплатных попыток.
  take(day: string, device: string, plan: Plan): TakeResult {
    for (const l of plan.limits) {
      if (this.count(l.lifetime ? LIFETIME : day, l.key) >= l.max) {
        return { ok: false, blocked: l.key.split(":")[0] as "ip" | "total", paid: false, remaining: 0 };
      }
    }
    const s = this.sub(device);
    let paid = false;
    let remaining: number;
    if (s && s.until > Date.now() && s.left > 0) {
      this.ctx.storage.sql.exec("UPDATE subs SET left = left - 1 WHERE email = ?", s.email);
      paid = true;
      remaining = s.left - 1;
    } else {
      const used = this.count(LIFETIME, "device:" + device);
      if (used >= plan.free) return { ok: false, blocked: "free", paid: false, remaining: 0, until: s?.until };
      this.bump(LIFETIME, "device:" + device, 1);
      remaining = plan.free - used - 1;
    }
    for (const l of plan.limits) this.bump(l.lifetime ? LIFETIME : day, l.key, 1);
    this.ctx.storage.sql.exec("DELETE FROM counts WHERE day < ?", day); // старые дни больше не нужны
    return { ok: true, paid, remaining, until: s?.until };
  }

  // Возвращает запрос, если ИИ не ответил (ошибка не должна съедать попытку)
  refund(day: string, device: string, plan: Plan, paid: boolean): void {
    if (paid) {
      const s = this.sub(device);
      if (s) this.ctx.storage.sql.exec("UPDATE subs SET left = left + 1 WHERE email = ?", s.email);
    } else {
      this.bump(LIFETIME, "device:" + device, -1);
    }
    for (const l of plan.limits) this.bump(l.lifetime ? LIFETIME : day, l.key, -1);
  }

  // Простые дневные лимиты без подписки (например, проверка по госномеру): все или ничего
  takeDaily(day: string, limits: Limit[]): Limit | null {
    for (const l of limits) if (this.count(day, l.key) >= l.max) return l;
    for (const l of limits) this.bump(day, l.key, 1);
    this.ctx.storage.sql.exec("DELETE FROM counts WHERE day < ?", day);
    return null;
  }

  refundDaily(day: string, limits: Limit[]): void {
    for (const l of limits) this.bump(day, l.key, -1);
  }

  // --- Оплата ---
  createOrder(orderId: string, device: string, email: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO orders (order_id, device, email, status, created) VALUES (?, ?, ?, 'NEW', ?)",
      orderId, device, email, Date.now(),
    );
  }

  // Вызывается из уведомления банка. Повторные уведомления по тому же заказу ничего не меняют.
  confirmOrder(orderId: string, perYear: number): boolean {
    const o = this.ctx.storage.sql.exec<{ device: string; email: string; status: string }>(
      "SELECT device, email, status FROM orders WHERE order_id = ?", orderId,
    ).toArray()[0];
    if (!o) return false;
    if (o.status === "CONFIRMED") return true;
    this.ctx.storage.sql.exec("UPDATE orders SET status = 'CONFIRMED' WHERE order_id = ?", orderId);
    const now = Date.now();
    const cur = this.ctx.storage.sql.exec<{ until: number; left: number }>("SELECT until, left FROM subs WHERE email = ?", o.email).toArray()[0];
    // Продление: год добавляется к текущему сроку, запас сводок складывается
    const until = (cur && cur.until > now ? cur.until : now) + YEAR_MS;
    const left = (cur && cur.until > now ? cur.left : 0) + perYear;
    this.ctx.storage.sql.exec(
      "INSERT INTO subs (email, until, left) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET until = ?, left = ?",
      o.email, until, left, until, left,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO devices (device, email) VALUES (?, ?) ON CONFLICT (device) DO UPDATE SET email = ?",
      o.device, o.email, o.email,
    );
    return true;
  }

  // Привязать это устройство к уже оплаченной подписке по email
  restore(device: string, email: string): boolean {
    const s = this.ctx.storage.sql.exec<{ until: number }>("SELECT until FROM subs WHERE email = ?", email).toArray()[0];
    if (!s || s.until <= Date.now()) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO devices (device, email) VALUES (?, ?) ON CONFLICT (device) DO UPDATE SET email = ?",
      device, email, email,
    );
    return true;
  }
}
