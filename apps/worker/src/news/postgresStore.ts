import {
  buildClusters,
  timeOf,
  type ClusterItem,
  type HeadlineCluster,
  type NewsImpact,
  type NewsTopic,
  type Session,
  type SourceTier,
} from '@vmgs/core';
import type { Pool } from 'pg';

import type {
  ImpactStore,
  MarketMoveRecord,
  MoveStore,
  NewItem,
  NewsSourceRow,
  NewsStore,
  RecentItem,
  SampleRecord,
  StoredItem,
  TopicStatRow,
} from './store';

type Num = string | number | null;
const num = (value: Num): number | null => (value === null ? null : Number(value));
const date = (value: Date | null): number | null => (value === null ? null : value.getTime());

/** The longest error text that is kept (`news_sources.last_error`). */
const ERROR_LENGTH = 500;

interface ItemRow {
  id: string;
  cluster_id: string;
  source_key: string;
  source_name: string;
  title: string;
  url: string;
  published_at: Date | null;
  first_seen_at: Date;
  topics: NewsTopic[];
  impact: NewsImpact;
  impact_score: Num;
}

const ITEM_COLUMNS = `i.id, i.cluster_id, i.source_key, s.name AS source_name, i.title, i.url,
  i.published_at, i.first_seen_at, i.topics, i.impact, i.impact_score`;

const clusterItem = (row: ItemRow): ClusterItem => ({
  id: row.id,
  clusterId: row.cluster_id,
  sourceKey: row.source_key,
  sourceName: row.source_name,
  title: row.title,
  url: row.url,
  publishedAt: date(row.published_at),
  firstSeenAt: row.first_seen_at.getTime(),
  topics: row.topics,
  impact: row.impact,
  score: Number(row.impact_score ?? 0),
});

/**
 * The headlines, their measured impact and the market moves in PostgreSQL: `news_sources`, `news_items`,
 * `news_impact_samples`, `news_topic_stats` and `market_events` (03_Data_Model). The worker role may read and
 * write all of them; it never changes `news_sources.enabled`.
 */
export class PostgresNewsStore implements NewsStore, ImpactStore, MoveStore {
  constructor(private readonly pool: Pool) {}

  // ------------------------------------------------------------------------------- the feeds

  async ensureSources(
    feeds: readonly { key: string; name: string; tier: SourceTier }[],
  ): Promise<void> {
    if (feeds.length === 0) return;
    await this.pool.query(
      `INSERT INTO news_sources (key, name, tier)
       SELECT x.key, x.name, x.tier FROM jsonb_to_recordset($1::jsonb) AS x(key text, name text, tier smallint)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier`,
      [JSON.stringify(feeds)],
    );
  }

  async sources(): Promise<NewsSourceRow[]> {
    const { rows } = await this.pool.query<{
      key: string;
      name: string;
      tier: number;
      enabled: boolean;
      last_ok_at: Date | null;
      last_error: string | null;
    }>('SELECT key, name, tier, enabled, last_ok_at, last_error FROM news_sources ORDER BY key');
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      tier: row.tier as SourceTier,
      enabled: row.enabled,
      lastOkAt: date(row.last_ok_at),
      lastError: row.last_error,
    }));
  }

  async recordOk(key: string, at: number): Promise<void> {
    await this.pool.query(
      'UPDATE news_sources SET last_ok_at = $2, last_error = NULL WHERE key = $1',
      [key, new Date(at)],
    );
  }

  async recordError(key: string, error: string): Promise<void> {
    await this.pool.query('UPDATE news_sources SET last_error = $2 WHERE key = $1', [
      key,
      error.slice(0, ERROR_LENGTH),
    ]);
  }

  // ------------------------------------------------------------------------------- the items

  async recentItems(since: number): Promise<RecentItem[]> {
    const { rows } = await this.pool.query<{ cluster_id: string; title: string; at: Date }>(
      `SELECT cluster_id, title, COALESCE(published_at, first_seen_at) AS at
         FROM news_items WHERE COALESCE(published_at, first_seen_at) >= $1`,
      [new Date(since)],
    );
    return rows.map((row) => ({
      clusterId: row.cluster_id,
      title: row.title,
      at: row.at.getTime(),
    }));
  }

  async insertItems(items: readonly NewItem[]): Promise<StoredItem[]> {
    // one source and hash is one item: the first of them in the batch is the one that is kept
    const seen = new Set<string>();
    const unique = items.filter((item) => {
      const key = `${item.sourceKey}|${item.urlHash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length === 0) return [];
    const batch = unique.map((item) => ({
      source_key: item.sourceKey,
      url_hash: item.urlHash,
      title: item.title,
      url: item.url,
      summary: item.summary,
      published_at: item.publishedAt === null ? null : new Date(item.publishedAt).toISOString(),
      first_seen_at: new Date(item.firstSeenAt).toISOString(),
      topics: item.topics,
      impact: item.impact,
      impact_score: item.impactScore,
      cluster_id: item.clusterId,
      classifier_version: item.classifierVersion,
    }));
    const { rows } = await this.pool.query<{ id: string; source_key: string; url_hash: string }>(
      `INSERT INTO news_items
         (source_key, url_hash, title, url, summary, published_at, first_seen_at, topics, impact,
          impact_score, cluster_id, classifier_version)
       SELECT x.source_key, x.url_hash, x.title, x.url, x.summary, x.published_at, x.first_seen_at,
              ARRAY(SELECT jsonb_array_elements_text(x.topics)), x.impact, x.impact_score,
              x.cluster_id, x.classifier_version
         FROM jsonb_to_recordset($1::jsonb) AS x(
           source_key text, url_hash text, title text, url text, summary text,
           published_at timestamptz, first_seen_at timestamptz, topics jsonb, impact text,
           impact_score numeric, cluster_id uuid, classifier_version text)
       ON CONFLICT (source_key, url_hash) DO NOTHING
       RETURNING id, source_key, url_hash`,
      [JSON.stringify(batch)],
    );
    const inserted = new Map(rows.map((row) => [`${row.source_key}|${row.url_hash}`, row.id]));
    return unique.flatMap((item) => {
      const id = inserted.get(`${item.sourceKey}|${item.urlHash}`);
      return id === undefined ? [] : [{ ...item, id }];
    });
  }

  async items(): Promise<ClusterItem[]> {
    const { rows } = await this.pool.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM news_items i JOIN news_sources s ON s.key = i.source_key
        ORDER BY i.first_seen_at, i.id`,
    );
    return rows.map(clusterItem);
  }

  async clustersSince(since: number): Promise<HeadlineCluster[]> {
    const { rows } = await this.pool.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM news_items i JOIN news_sources s ON s.key = i.source_key
        WHERE i.cluster_id IN (SELECT cluster_id FROM news_items WHERE first_seen_at >= $1)
        ORDER BY i.first_seen_at, i.id`,
      [new Date(since)],
    );
    return buildClusters(rows.map(clusterItem));
  }

  // ------------------------------------------------------------------------------- the samples

  async unmeasured(since: number, until: number): Promise<HeadlineCluster[]> {
    const { rows } = await this.pool.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM news_items i JOIN news_sources s ON s.key = i.source_key
        WHERE i.cluster_id IN (
          SELECT n.cluster_id FROM news_items n
           WHERE NOT EXISTS (SELECT 1 FROM news_impact_samples p WHERE p.cluster_id = n.cluster_id)
           GROUP BY n.cluster_id
          HAVING COALESCE(min(n.published_at), min(n.first_seen_at)) BETWEEN $1 AND $2)
        ORDER BY i.first_seen_at, i.id`,
      [new Date(since), new Date(until)],
    );
    return buildClusters(rows.map(clusterItem)).filter(
      (cluster) => timeOf(cluster) >= since && timeOf(cluster) <= until,
    );
  }

  async saveSample(sample: SampleRecord): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO news_impact_samples
         (cluster_id, topics, impact, published_at, session, atr5, move_2m, move_5m, move_10m, max_abs_10m)
       VALUES ($1, $2::text[], $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (cluster_id) DO NOTHING`,
      [
        sample.clusterId,
        [...sample.topics],
        sample.impact,
        new Date(sample.publishedAt),
        sample.session,
        sample.atr5,
        sample.move2m,
        sample.move5m,
        sample.move10m,
        sample.maxAbs10m,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async rebuildStats(at: number): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO news_topic_stats
         (topic, impact, n, moved_1atr, sum_abs_atr_10m, sum_signed_atr_10m, updated_at)
       SELECT t.topic, s.impact, count(*)::int,
              (count(*) FILTER (WHERE s.max_abs_10m >= s.atr5))::int,
              sum(abs(s.move_10m) / s.atr5), sum(s.move_10m / s.atr5), $1
         FROM news_impact_samples s
        CROSS JOIN LATERAL (SELECT DISTINCT unnest(s.topics) AS topic) t
        WHERE s.move_10m IS NOT NULL AND s.atr5 > 0
        GROUP BY t.topic, s.impact
       ON CONFLICT (topic, impact) DO UPDATE SET
         n = EXCLUDED.n,
         moved_1atr = EXCLUDED.moved_1atr,
         sum_abs_atr_10m = EXCLUDED.sum_abs_atr_10m,
         sum_signed_atr_10m = EXCLUDED.sum_signed_atr_10m,
         updated_at = EXCLUDED.updated_at`,
      [new Date(at)],
    );
    return result.rowCount ?? 0;
  }

  async sampleSessions(): Promise<
    { topic: NewsTopic; impact: NewsImpact; session: Session; n: number }[]
  > {
    const { rows } = await this.pool.query<{
      topic: NewsTopic;
      impact: NewsImpact;
      session: Session;
      n: number;
    }>(
      `SELECT t.topic, s.impact, s.session, count(*)::int AS n
         FROM news_impact_samples s
        CROSS JOIN LATERAL (SELECT DISTINCT unnest(s.topics) AS topic) t
        GROUP BY t.topic, s.impact, s.session`,
    );
    return rows;
  }

  async saveBaselines(
    rows: readonly { topic: NewsTopic; impact: NewsImpact; baseline: number | null }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.pool.query(
      `UPDATE news_topic_stats t SET baseline_moved_1atr_share = x.baseline
         FROM jsonb_to_recordset($1::jsonb) AS x(topic text, impact text, baseline numeric)
        WHERE t.topic = x.topic AND t.impact = x.impact`,
      [JSON.stringify(rows)],
    );
  }

  async topicStats(): Promise<TopicStatRow[]> {
    const { rows } = await this.pool.query<{
      topic: NewsTopic;
      impact: NewsImpact;
      n: number;
      moved_1atr: number;
      sum_abs_atr_10m: Num;
      sum_signed_atr_10m: Num;
      baseline: Num;
    }>(
      `SELECT topic, impact, n, moved_1atr, sum_abs_atr_10m, sum_signed_atr_10m,
              baseline_moved_1atr_share AS baseline
         FROM news_topic_stats ORDER BY topic, impact`,
    );
    return rows.map((row) => ({
      topic: row.topic,
      impact: row.impact,
      n: row.n,
      moved1atr: row.moved_1atr,
      sumAbsAtr10m: Number(row.sum_abs_atr_10m),
      sumSignedAtr10m: Number(row.sum_signed_atr_10m),
      baseline: num(row.baseline),
    }));
  }

  async eventTimes(from: number, until: number): Promise<number[]> {
    const { rows } = await this.pool.query<{ at: Date }>(
      `SELECT at FROM (
         SELECT COALESCE(published_at, first_seen_at) AS at FROM news_items
         UNION ALL
         SELECT scheduled_at AS at FROM macro_events WHERE importance = 'high'
       ) events WHERE at BETWEEN $1 AND $2 ORDER BY at`,
      [new Date(from), new Date(until)],
    );
    return rows.map((row) => row.at.getTime());
  }

  // ------------------------------------------------------------------------------- the moves

  async insertMove(move: MarketMoveRecord): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO market_events (kind, detected_at, window_s, move_usd, move_atr, spread, headlines, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb) RETURNING id`,
      [
        move.kind,
        new Date(move.detectedAt),
        move.windowS,
        move.moveUsd,
        move.moveAtr,
        move.spread,
        JSON.stringify(move.headlines),
        JSON.stringify(move.meta),
      ],
    );
    return Number(rows[0]?.id);
  }

  async lastMoveAt(): Promise<number | null> {
    const { rows } = await this.pool.query<{ at: Date | null }>(
      'SELECT max(detected_at) AS at FROM market_events',
    );
    return date(rows[0]?.at ?? null);
  }

  async moves(): Promise<(MarketMoveRecord & { readonly id: number })[]> {
    const { rows } = await this.pool.query<{
      id: string;
      kind: MarketMoveRecord['kind'];
      detected_at: Date;
      window_s: number;
      move_usd: Num;
      move_atr: Num;
      spread: Num;
      headlines: MarketMoveRecord['headlines'];
      meta: Record<string, unknown>;
    }>(
      `SELECT id, kind, detected_at, window_s, move_usd, move_atr, spread, headlines, meta
         FROM market_events ORDER BY id`,
    );
    return rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind,
      detectedAt: row.detected_at.getTime(),
      windowS: row.window_s,
      moveUsd: Number(row.move_usd),
      moveAtr: Number(row.move_atr),
      spread: num(row.spread),
      headlines: row.headlines,
      meta: row.meta,
    }));
  }
}
