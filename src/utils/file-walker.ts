import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * 递归扫描目录下所有 .java 文件，返回绝对路径列表。
 * 借鉴参考工程 processDirectory 的递归骨架，但改为收集而非就地处理。
 */
export async function collectJavaFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  await walk(dir, out);
  return out;
}

async function walk(dir: string, out: string[]) {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.java')) {
      out.push(full);
    }
  }
}
