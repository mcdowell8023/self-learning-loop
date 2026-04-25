// src/review/types.ts
//
// Four-Dimension Review Gate (T-P1a-004) 类型定义
//
// Task 规范：语义 / 安全 / 冲突 / 元信息 四维
// 方案 v5.0.3 §5.4 映射：
//   - 元信息 ← D1 Schema 校验（不可挽救）
//   - 安全   ← D2 扩展（黑名单 + 敏感路径；替代 Phase 1a 简化的 assertion 检查）
//   - 冲突   ← D3 唯一性 + 与现有 AGENTS.md/TOOLS.md 规则冲突
//   - 语义   ← D4 文本质量 + 可验证性
export const DEFAULT_REVIEW_CONFIG = {
    minActionLength: 8,
    minTriggerLength: 4,
    similarityThreshold: 0.9,
    ngramSize: 3,
    bannedKeywords: [
        'rm -rf /',
        'rm -rf ~',
        'rm -rf $home',
        'dd if=',
        'mkfs',
        ':(){ :|:& };:', // fork bomb
        'chmod -r 777 /',
        'sudo rm',
        // ssh 私钥操作
        'ssh-keygen -f ~/.ssh',
        'cat ~/.ssh/id_',
    ],
    sensitivePaths: [
        '~/.ssh/',
        '/etc/shadow',
        '/etc/passwd',
        '~/code_key',
        '/root/',
        '~/.gnupg/',
        '~/.aws/credentials',
    ],
    secretPatterns: [
        /sk-[a-zA-Z0-9]{20,}/, // OpenAI-ish
        /AKIA[0-9A-Z]{16}/, // AWS access key
        /ghp_[a-zA-Z0-9]{20,}/, // GitHub PAT
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private keys
    ],
    conflictKeywordThreshold: 3,
    useLlmForConflict: true,
    requiredFields: ['scope', 'problem_category', 'trigger_conditions', 'recommended_action'],
    allowedScopePatterns: [
        /^general$/,
        /^skill$/,
        /^tool:[a-zA-Z0-9_.\-]+$/,
        /^role:[a-zA-Z0-9_.\-]+$/,
    ],
    requireVerifiableAssertion: false, // Phase 1a 可选，默认不强制（避免阻塞）
};
