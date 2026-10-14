import type { MinuteStatDto } from "@zzirit-guard/shared";
import type { Database } from "../db/database.js";
import { floorToMinute, type Clock } from "../time.js";

/** 분당 통계 항목(minute_stat 열 이름과 같다). */
export const STAT_FIELDS = [
  "received", "skipped", "deduplicated", "stage1_forwarded", "stage2_done", "stage2_dropped", "ai_unchecked", "candidates", "auto_hidden", "shadow", "invalid_events",
] as const;

/** 통계 항목 이름. */
export type StatField = (typeof STAT_FIELDS)[number];

/** 분당 통계. 메시지마다 DB에 쓰지 않으려고 메모리에 모았다가 flush로 더한다. */
export interface MinuteStats {
  increment(channelId: string, field: StatField, amount?: number): void;
  flush(): void;
  /** sinceMs 이후의 분당 통계를 분 순서로 읽는다. 행 형태는 shared의 MinuteStatDto와 같다(웹이 같은 타입을 쓴다). */
  recent(channelId: string, sinceMs: number): MinuteStatDto[];
}

/** 메모리에 모은 한 분의 값. */
interface PendingBucket {
  channelId: string;
  minute: number;
  counts: Partial<Record<StatField, number>>;
}

/** 분당 통계를 만든다. */
export function createMinuteStats(database: Database, clock: Clock): MinuteStats {
  let pending = new Map<string, PendingBucket>();
  const upsert = database.prepare(
    `INSERT INTO minute_stat (channel_id, minute, ${STAT_FIELDS.join(", ")}) VALUES (?, ?, ${STAT_FIELDS.map(() => "?").join(", ")})
     ON CONFLICT (channel_id, minute) DO UPDATE SET ${STAT_FIELDS.map((field) => `${field} = ${field} + excluded.${field}`).join(", ")}`,
  );
  /** 모은 값을 한 트랜잭션으로 저장한다. 하나라도 실패하면 전부 롤백된다. */
  const writeBuckets = (buckets: readonly PendingBucket[]): void =>
    database.transaction(() => buckets.forEach((bucket) => upsert.run(bucket.channelId, bucket.minute, ...STAT_FIELDS.map((field) => bucket.counts[field] ?? 0))))();
  /**
   * 저장에 실패한 값을 다시 모아 둔다. 실패 사이에 같은 분에 쌓인 값은 더해서 합친다.
   * 분당 통계는 1단계 핵심 지표라, 저장 실패로 조용히 사라지면 안 되기 때문이다.
   */
  const restoreBuckets = (buckets: readonly PendingBucket[]): void => {
    for (const bucket of buckets) {
      const key = `${bucket.channelId}|${bucket.minute}`;
      const current = pending.get(key);
      if (current === undefined) {
        pending.set(key, bucket);
        continue;
      }
      for (const field of STAT_FIELDS) {
        current.counts[field] = (current.counts[field] ?? 0) + (bucket.counts[field] ?? 0);
      }
    }
  };
  return {
    increment(channelId, field, amount = 1) {
      const minute = floorToMinute(clock());
      const key = `${channelId}|${minute}`;
      const bucket = pending.get(key) ?? { channelId, minute, counts: {} };
      bucket.counts[field] = (bucket.counts[field] ?? 0) + amount;
      pending.set(key, bucket);
    },
    flush() {
      const buckets = [...pending.values()];
      pending = new Map();
      try {
        writeBuckets(buckets);
      } catch (error) {
        restoreBuckets(buckets);
        throw error;
      }
    },
    recent: (channelId, sinceMs) =>
      database.prepare(`SELECT minute, ${STAT_FIELDS.join(", ")} FROM minute_stat WHERE channel_id = ? AND minute >= ? ORDER BY minute`).all(channelId, sinceMs) as MinuteStatDto[],
  };
}
