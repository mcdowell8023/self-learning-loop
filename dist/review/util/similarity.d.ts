/** 生成字符级 n-gram 集合（小写 + 折叠空白） */
export declare function ngrams(text: string, n: number): Set<string>;
/** Jaccard 相似度：|A ∩ B| / |A ∪ B| */
export declare function jaccard(a: Set<string>, b: Set<string>): number;
/** 两段文本的 n-gram Jaccard 相似度 */
export declare function textSimilarity(a: string, b: string, n?: number): number;
/** 词级 token 集合（用于冲突维度的 keyword 命中计数） */
export declare function wordTokens(text: string): Set<string>;
