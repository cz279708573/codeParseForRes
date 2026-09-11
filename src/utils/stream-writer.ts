import { createWriteStream } from 'fs';
import { once } from 'events';

/**
 * 大结果落盘的写出工具（快路径）。
 *
 * 背景：一次性 `JSON.stringify(result, null, 2)` 会超出 V8 单字符串长度上限
 * （约 512M 字符）抛 RangeError，同时把整个字符串留在堆里。
 *
 * 关键点：**不要逐 token 地 yield**。上一版用 async generator 每产出
 * 一个 `{` / `,` / 字段值就 await 一次，千万级 token 的 Promise 调度
 * 开销远大于序列化本身，慢到不可用。
 *
 * 这里的做法是——
 *   - 顶层对象的数组字段：逐元素调用**原生** `JSON.stringify`（元素内部整棵子树
 *     由原生 C++ 一次性序列化，快且不会构造超大字符串）；
 *   - 非数组字段：整体原生 stringify（都很小）；
 *   - 写入侧按 1MB 缓冲合并，配合 drain 处理背压。
 * 于是 await 次数从"千万级"降到"元素级 + 每 1MB 一次"。
 */

/** 写入回调：写入方内部会缓冲，满阈值才真正落盘 */
export type Sink = (chunk: string) => Promise<void>;

/** 默认缓冲阈值 1MB，可按内存/磁盘情况调整 */
export const DEFAULT_FLUSH_BYTES = 1 << 20;

/**
 * 打开文件的写入会话：produce 通过 write 输出，内部自动缓冲与背压。
 */
export async function writeWithSink(
  filePath: string,
  produce: (write: Sink) => Promise<void>,
  flushBytes: number = DEFAULT_FLUSH_BYTES,
): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: 'utf8' });
  let buf = '';

  const write: Sink = async (chunk: string) => {
    buf += chunk;
    if (buf.length >= flushBytes) {
      const out = buf;
      buf = '';
      if (!stream.write(out)) await once(stream, 'drain');
    }
  };

  try {
    await produce(write);
    if (buf) {
      const out = buf;
      buf = '';
      if (!stream.write(out)) await once(stream, 'drain');
    }
  } catch (e) {
    stream.destroy();
    throw e;
  }

  await new Promise<void>((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
}

/** 数组：逐元素原生 stringify，永不构造超大字符串 */
async function writeArray(write: Sink, items: unknown[], indent: number): Promise<void> {
  if (items.length === 0) {
    await write('[]');
    return;
  }
  await write('[');
  for (let i = 0; i < items.length; i++) {
    if (i > 0) await write(',');
    await write(JSON.stringify(items[i] ?? null, null, indent));
  }
  await write(']');
}

/**
 * 写出任意值：数组走逐元素快路径，对象逐字段，其余整体 stringify。
 * 只保证 JSON 合法，不保证缩进严格对齐（数组元素由原生按深度 0 缩进）。
 */
export async function writeValue(
  write: Sink,
  value: unknown,
  indent: number = 2,
): Promise<void> {
  if (value === null || typeof value !== 'object') {
    await write(JSON.stringify(value ?? null));
    return;
  }
  if (Array.isArray(value)) {
    await writeArray(write, value, indent);
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  const unit = indent > 0 ? ' '.repeat(indent) : '';
  if (entries.length === 0) {
    await write('{}');
    return;
  }

  await write('{');
  for (let i = 0; i < entries.length; i++) {
    const [k, v] = entries[i];
    if (i > 0) await write(',');
    if (unit) await write('\n' + unit);
    await write(JSON.stringify(k) + ':' + (unit ? ' ' : ''));
    if (Array.isArray(v)) await writeArray(write, v, indent);
    else await write(JSON.stringify(v ?? null, null, indent));
  }
  if (unit) await write('\n');
  await write('}');
}

/** 流式写 JSON 文件；indent=0 为紧凑格式 */
export async function writeJsonFile(
  filePath: string,
  value: unknown,
  indent: number = 2,
): Promise<void> {
  await writeWithSink(filePath, async (write) => {
    await writeValue(write, value, indent);
  });
}

/**
 * 流式写"内嵌 JSON 的自包含 HTML"：head + JSON + tail 三段分别落盘。
 * escapeJson 默认把 `<` 转成 `\u003c`（合法 JSON 转义），防止提前闭合 script。
 */
export async function writeHtmlWithJson(
  filePath: string,
  head: string,
  value: unknown,
  tail: string,
  escapeJson: (s: string) => string = (s) => s.replace(/</g, '\\u003c'),
): Promise<void> {
  await writeWithSink(filePath, async (write) => {
    await write(head);
    const wrapped: Sink = async (chunk) => write(escapeJson(chunk));
    await writeValue(wrapped, value, 0);
    await write(tail);
  });
}
