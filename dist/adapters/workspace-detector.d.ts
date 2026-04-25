export interface DetectedWorkspace {
    runtime: 'openclaw' | 'claude-code' | 'opencode' | 'codex' | 'generic';
    workspacePath: string;
    agentsRoot?: string;
    confidence: number;
}
/**
 * Detect all AI coding runtime workspaces on the current machine.
 * Returns results sorted by priority (highest first), filtering out
 * runtimes where no checks passed.
 *
 * @param homeOverride - Override homedir for testing.
 */
export declare function detectWorkspaces(homeOverride?: string): Promise<DetectedWorkspace[]>;
