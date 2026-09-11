import { promises as fs } from 'fs';
import type { AnnotationOccurrence } from '../analyzer/annotation-collector';

/**
 * 行号计算：读入源文件建立换行偏移表，按字符偏移二分查行号。
 * 只读取涉及的文件，且同一次调用内缓存，避免重复 IO。
 */

export interface Locatable {
  filePath: string;
  startIndex: number;
  line?: number;
}

export async function attachLineNumbers<T extends Locatable>(items: T[]): Promise<T[]> {
  const byFile = new Map<string, T[]>();
  for (const it of items) {
    const list = byFile.get(it.filePath);
    if (list) list.push(it);
    else byFile.set(it.filePath, [it]);
  }

  for (const [file, list] of byFile) {
    let offsets: number[];
    try {
      offsets = buildOffsets(await fs.readFile(file, 'utf8'));
    } catch {
      continue; // 文件不可读时跳过，行号留空
    }
    for (const it of list) it.line = lineOf(offsets, it.startIndex);
  }
  return items;
}

/** 所有换行符的偏移（升序） */
function buildOffsets(content: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) offsets.push(i);
  }
  return offsets;
}

/** 偏移 -> 1 基行号 */
function lineOf(offsets: number[], index: number): number {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < index) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/** 便于外部复用：仅取注解引用的行号 */
export async function withAnnotationLines(
  occurrences: AnnotationOccurrence[],
): Promise<AnnotationOccurrence[]> {
  return attachLineNumbers(occurrences);
}
