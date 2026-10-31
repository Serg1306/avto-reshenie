// Лимиты ИИ-запросов (на всё время и дневные). Один экземпляр Durable Object на весь сервис,
// счётчики в SQLite: так проверка и увеличение атомарны даже при одновременных запросах.
import { DurableObject } from "cloudflare:workers";

export interface Limit {
  key: string; // например "device:abc", "ip:1.2.3.4", "total"
  max: number;
  lifetime?: boolean; // true: лимит на всё время, иначе на текущий день
}

const LIFETIME = "all"; // вместо даты; "all" > любой даты, поэтому не удаляется очисткой

export class Limiter extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, key))",
    );
  }

  private count(day: string, key: string): number {
    const row = this.ctx.storage.sql.exec<{ n: number }>("SELECT n FROM counts WHERE day = ? AND key = ?", day, key).toArray()[0];
    return row ? row.n : 0;
  }

  // Списывает по одному запросу со всех лимитов, если ни один не исчерпан.
  // Возвращает, какой лимит кончился, и сколько осталось по первому (лимит устройства).
  take(day: string, limits: Limit[]): { ok: boolean; blocked?: string; remaining: number } {
    const d = (l: Limit) => (l.lifetime ? LIFETIME : day);
    for (const l of limits) {
      if (this.count(d(l), l.key) >= l.max) return { ok: false, blocked: l.key.split(":")[0], remaining: 0 };
    }
    for (const l of limits) {
      this.ctx.storage.sql.exec(
        "INSERT INTO counts (day, key, n) VALUES (?, ?, 1) ON CONFLICT (day, key) DO UPDATE SET n = n + 1",
        d(l), l.key,
      );
    }
    // Старые дни больше не нужны
    this.ctx.storage.sql.exec("DELETE FROM counts WHERE day < ?", day);
    const first = limits[0];
    return { ok: true, remaining: first ? first.max - this.count(d(first), first.key) : 0 };
  }

  // Возвращает запрос, если ИИ не ответил (ошибка не должна съедать лимит)
  refund(day: string, limits: Limit[]): void {
    for (const l of limits) {
      this.ctx.storage.sql.exec("UPDATE counts SET n = MAX(n - 1, 0) WHERE day = ? AND key = ?", l.lifetime ? LIFETIME : day, l.key);
    }
  }
}
