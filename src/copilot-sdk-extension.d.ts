declare module "@github/copilot-sdk/extension" {
    type MaybePromise<T> = T | Promise<T>;

    interface SessionStartInput {
        cwd: string;
        source: "startup" | "resume" | "new";
        initialPrompt?: string;
        timestamp?: number;
    }

    interface UserPromptSubmittedInput {
        cwd: string;
        prompt: string;
        timestamp?: number;
    }

    interface SessionHookResult {
        additionalContext?: string;
    }

    interface JoinSessionConfig {
        tools?: unknown[];
        hooks?: {
            onSessionStart?: (input: SessionStartInput) => MaybePromise<SessionHookResult | void>;
            onUserPromptSubmitted?: (input: UserPromptSubmittedInput) => MaybePromise<SessionHookResult | void>;
        };
    }

    export function joinSession(config: JoinSessionConfig): Promise<void>;
}
