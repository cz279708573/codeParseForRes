import { promises as fs } from 'fs';
import * as path from 'path';
import { DEFAULT_SHARD_SIZE } from './utils/shard-writer';

/**
 * 工程配置：控制"哪些注解需要单独出分页页面"。
 *
 * 优先顺序：命令行参数 > 配置文件 > 内置默认值。
 * 配置文件默认读取运行目录下的 codeparse.config.json，可用 --config 指定其它路径。
 */

export interface AppConfig {
  /**
   * 需要单独出分页页面的注解名列表。
   * 支持简单名（Override）或全限定名（org.springframework.stereotype.Service）；
   * 简单名会同时匹配源码中写作全限定形式的同一注解。
   */
  annotations: string[];
  /** 注解详情页每页展示条数 */
  pageSize: number;
  /** 输出 JSON 的缩进空格数；0 为紧凑格式（体积更小、写盘更快） */
  jsonIndent?: number;
  /** 跳过 result.json（超大工程可省掉一次大文件落盘，HTML 报告照常生成） */
  skipJson?: boolean;
  /** 开启分片落盘：大数组按数量切成多个文件，主文件退化为清单 */
  shard?: boolean;
  /** 每片元素数量：classes/relations/unresolved/nodes/edges */
  shardSize?: Partial<ShardSizeSpec>;
}

/** 分片大小字段名与默认值一一对应，默认值定义在 utils/shard-writer */
export type ShardSizeSpec = typeof DEFAULT_SHARD_SIZE;

export const DEFAULT_CONFIG: AppConfig = {
  annotations: [],
  pageSize: 50,
  jsonIndent: 2,
  skipJson: false,
  shard: false,
};

export const CONFIG_FILE_NAME = 'codeparse.config.json';

/** 去掉前导 @ 与空白，得到规范化注解名 */
export function normalizeAnnotationName(raw: string): string {
  return raw.trim().replace(/^@+/, '');
}

/** 取注解的简单名：org.springframework.stereotype.Service -> Service */
export function simpleAnnotationName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : name;
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

/** 将任意输入收敛为合法配置，非法字段回落到默认值 */
export function normalizeConfig(raw: Partial<AppConfig> | null | undefined): AppConfig {
  const annotations = Array.isArray(raw?.annotations)
    ? dedupe(
        (raw!.annotations as unknown[])
          .filter((x): x is string => typeof x === 'string')
          .map(normalizeAnnotationName)
          .filter(Boolean),
      )
    : [];
  const rawSize = raw?.pageSize;
  const pageSize =
    typeof rawSize === 'number' && Number.isFinite(rawSize) && rawSize > 0
      ? Math.floor(rawSize)
      : DEFAULT_CONFIG.pageSize;
  const rawIndent = raw?.jsonIndent;
  const jsonIndent =
    typeof rawIndent === 'number' && Number.isFinite(rawIndent) && rawIndent >= 0
      ? Math.floor(rawIndent)
      : DEFAULT_CONFIG.jsonIndent;
  return {
    annotations,
    pageSize,
    jsonIndent,
    skipJson: raw?.skipJson === true,
    shard: raw?.shard === true,
    shardSize: raw?.shardSize ? { ...raw.shardSize } : undefined,
  };
}

/**
 * 解析分片大小：配置/命令行覆盖默认值，并映射成 result / graph 的实际字段名。
 * @returns { classes, relations, unresolvedSymbols, nodes, edges }
 */
export function resolveShardSize(
  override?: Partial<ShardSizeSpec>,
): {
  classes: number;
  relations: number;
  unresolvedSymbols: number;
  nodes: number;
  edges: number;
} {
  const pick = (key: keyof typeof DEFAULT_SHARD_SIZE): number => {
    const v = override?.[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0
      ? Math.floor(v)
      : (DEFAULT_SHARD_SIZE as Record<string, number>)[key];
  };
  return {
    classes: pick('classes'),
    relations: pick('relations'),
    unresolvedSymbols: pick('unresolved'),
    nodes: pick('nodes'),
    edges: pick('edges'),
  };
}

/** 解析 `nodes=5000,edges=20000` 形式的命令行参数 */
export function parseShardSizeArg(
  text: string | undefined,
): Partial<ShardSizeSpec> | undefined {
  if (!text) return undefined;
  // 纯数字则视为统一大小
  if (/^\d+$/.test(text.trim())) {
    const n = Number(text.trim());
    return { classes: n, relations: n, unresolved: n, nodes: n, edges: n };
  }
  const out: Record<string, number> = {};
  for (const part of text.split(',')) {
    const [k, v] = part.split('=');
    const num = Number(v);
    if (k && Number.isFinite(num) && num > 0) out[k.trim()] = Math.floor(num);
  }
  return out as Partial<ShardSizeSpec>;
}

/**
 * 读取配置文件。未显式指定路径且文件不存在时静默返回默认配置；
 * 显式指定却读不到则抛错（便于发现路径写错）。
 */
export async function loadConfigFile(configPath?: string): Promise<AppConfig> {
  const target = configPath ?? path.join(process.cwd(), CONFIG_FILE_NAME);
  try {
    const raw = await fs.readFile(target, 'utf8');
    return normalizeConfig(JSON.parse(raw) as Partial<AppConfig>);
  } catch (e) {
    if (configPath) throw e;
    return { ...DEFAULT_CONFIG };
  }
}

/** 命令行解析结果（均为可选覆盖项） */
export interface CliOverrides {
  /** 逗号分隔的注解名列表 */
  annotations?: string;
  pageSize?: string;
  config?: string;
  jsonIndent?: string;
  /** 传 'true' 或空值即视为开启 */
  noJson?: string | boolean;
  /** 分片开关 */
  shard?: string | boolean;
  /** 分片大小，如 nodes=5000,edges=20000，或直接给一个统一数字 */
  shardSize?: string;
}

/** 合并"配置文件 + 命令行"得到最终配置 */
export function mergeConfig(fileCfg: AppConfig, cli: CliOverrides = {}): AppConfig {
  const cliAnnos = cli.annotations
    ? dedupe(
        cli.annotations
          .split(',')
          .map(normalizeAnnotationName)
          .filter(Boolean),
      )
    : [];
  const cliSize = Number(cli.pageSize);
  const cliIndent = Number(cli.jsonIndent);
  return {
    annotations: cliAnnos.length ? cliAnnos : fileCfg.annotations,
    pageSize: Number.isFinite(cliSize) && cliSize > 0 ? Math.floor(cliSize) : fileCfg.pageSize,
    jsonIndent:
      Number.isFinite(cliIndent) && cliIndent >= 0
        ? Math.floor(cliIndent)
        : (fileCfg.jsonIndent ?? DEFAULT_CONFIG.jsonIndent),
    skipJson: cli.noJson === true || cli.noJson === 'true' || cli.noJson === '' || fileCfg.skipJson === true,
    shard: cli.shard === true || cli.shard === 'true' || cli.shard === '' || fileCfg.shard === true,
    shardSize: parseShardSizeArg(cli.shardSize) ?? fileCfg.shardSize,
  };
}

/** 一次性完成：读配置文件 → 应用命令行覆盖 */
export async function resolveConfig(cli: CliOverrides = {}): Promise<AppConfig> {
  const fileCfg = await loadConfigFile(cli.config);
  return mergeConfig(fileCfg, cli);
}
