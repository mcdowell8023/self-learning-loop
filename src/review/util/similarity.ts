// src/review/util/similarity.ts
//
// 简单文本相似度（字符级 n-gram Jaccard）——Phase 1a 够用，别上 embedding。

/** 生成字符级 n-gram 集合（小写 + 折叠空白） */
export function ngrams(text: string, n: number): Set<string> {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const out = new Set<string>();
  if (norm.length === 0) return out;
  if (norm.length <= n) {
    out.add(norm);
    return out;
  }
  for (let i = 0; i <= norm.length - n; i++) {
    out.add(norm.slice(i, i + n));
  }
  return out;
}

/** Jaccard 相似度：|A ∩ B| / |A ∪ B| */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/** 两段文本的 n-gram Jaccard 相似度 */
export function textSimilarity(a: string, b: string, n = 3): number {
  return jaccard(ngrams(a, n), ngrams(b, n));
}

/** 词级 token 集合（用于冲突维度的 keyword 命中计数） */
export function wordTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-./]+/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3), // 过滤停用短词
  );
}
