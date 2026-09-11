import * as path from 'path';
import { promises as fs } from 'fs';
import { writeJsonFile } from './stream-writer';

/**
 * 分片落盘：把大数组按元素数量切到多个文件，并写一个清单文件。
 *
 * 产物形如（baseName = result.graph，字段 nodes/edges）：
 *   result.graph.json              —— 清单（小文件，含计数与分片列表）
 *   result.graph.nodes.0001.json   —— [ 前 N 个节点 ]
 *   result.graph.nodes.0002.json
 *   result.graph.edges.0001.json
 *
 * 每个分片内部仍走「逐元素原生 stringify」的快路径，
 * 所以既不会构造超大字符串，也保持接近原生的序列化速度。
 */

export interface ShardInfo {
  /** 数组字段名 */
  field: string;
  /** 元素总数 */
  count: number;
  /** 每片元素数量 */
  perShard: number;
  /** 分片文件名（相对输出目录） */
  files: string[];
}

export interface ShardManifest {
  sharded: true;
  generatedBy: string;
  /** 每个数组字段的元素总数 */
  counts: Record<string, number>;
  /** 每个数组字段的分片信息 */
  shards: Record<string, Omit<ShardInfo, 'field'>>;
  /** 其余非数组字段原样保留 */
  [key: string]: unknown;
}

/** 默认每片元素数量 */
export const DEFAULT_SHARD_SIZE = {
  classes: 500,
  relations: 5000,
  unresolved: 5000,
  nodes: 5000,
  edges: 20000,
};

function pad(n: number, width: number): string {
  return String(n).padStart(Math.max(4, width), '0');
}

/**
 * 分片写出一个对象中的若干数组字段。
 *
 * @param outDir    输出目录
 * @param baseName 文件基名，如 result / result.graph
 * @param obj       原始对象
 * @param perShard 字段名 -> 每片元素数量（0 或缺失表示不分片）
 * @param indent    JSON 缩进
 * @returns 清单文件路径与各字段分片信息
 */
export async function writeSharded(
  outDir: string,
  baseName: string,
  obj: Record<string, unknown>,
  perShard: Record<string, number>,
  indent: number = 2,
): Promise<{ manifestPath: string; manifest: ShardManifest; shards: ShardInfo[] }> {
  await fs.mkdir(outDir, { recursive: true });

  const shards: ShardInfo[] = [];
  const counts: Record<string, number> = {};
  const shardMap: Record<string, Omit<ShardInfo, 'field'>> = {};
  const rest: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && (perShard[key] ?? 0) > 0) {
      const size = perShard[key];
      const items = value;
      counts[key] = items.length;

      if (items.length === 0) {
        shardMap[key] = { count: 0, perShard: size, files: [] };
        shards.push({ field: key, count: 0, perShard: size, files: [] });
        continue;
      }

      const total = Math.ceil(items.length / size);
      const width = String(total).length;
      const files: string[] = [];
      for (let i = 0, n = 1; i < items.length; i += size, n++) {
        const file = `${baseName}.${key}.${pad(n, width)}.json`;
        const slice = items.slice(i, i + size);
        await writeJsonFile(path.join(outDir, file), slice, indent);
        files.push(file);
      }
      shardMap[key] = { count: items.length, perShard: size, files };
      shards.push({ field: key, count: items.length, perShard: size, files });
    } else if (!Array.isArray(value)) {
      rest[key] = value;
    } else {
      // 未配置分片大小的数组：仍保留在清单里（通常数据量小）
      rest[key] = value;
    }
  }

  const manifest: ShardManifest = {
    sharded: true,
    generatedBy: 'codeParseForRes',
    counts,
    shards: shardMap,
    ...rest,
  };
  const manifestPath = path.join(outDir, `${baseName}.json`);
  await writeJsonFile(manifestPath, manifest, indent);

  return { manifestPath, manifest, shards };
}

/**
 * 按清单把分片重新组装成完整对象（便于程序化读取或校验）。
 */
export async function readSharded(manifestPath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as ShardManifest;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(manifest)) {
    if (['sharded', 'generatedBy', 'counts', 'shards'].includes(key)) continue;
    out[key] = value;
  }

  for (const [field, info] of Object.entries(manifest.shards ?? {})) {
    const merged: unknown[] = [];
    for (const file of info.files ?? []) {
      const part = JSON.parse(await fs.readFile(path.join(path.dirname(manifestPath), file), 'utf8'));
      merged.push(...part);
    }
    out[field] = merged;
  }

  return out;
}
