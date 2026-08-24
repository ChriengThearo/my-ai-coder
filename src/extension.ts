import * as vscode from 'vscode';
import axios from 'axios';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
    spawn,
    ChildProcess
} from 'child_process';

// ============================================================
// Types
// ============================================================

interface ToolCall {
    id: string;

    type: 'function';

    function: {
        name: string;
        arguments: string;
    };
}

interface ChatMessage {
    role:
        | 'user'
        | 'assistant'
        | 'tool';

    content:
        string | null;

    tool_calls?:
        ToolCall[];

    tool_call_id?:
        string;
}

interface ChatSession {
    id:
        string;

    title:
        string;

    messages:
        ChatMessage[];

    updatedAt:
        number;
}

interface ActivityItem {
    id:
        string;

    type:
        | 'status'
        | 'tool'
        | 'terminal'
        | 'file'
        | 'result'
        | 'error';

    title:
        string;

    detail?:
        string;

    status?:
        | 'running'
        | 'completed'
        | 'failed'
        | 'info';

    toolName?:
        string;

    args?:
        any;

    timestamp:
        number;
}

interface AgentState {
    running:
        boolean;

    stopped:
        boolean;

    activities:
        ActivityItem[];
}

// ============================================================
// Storage
// ============================================================

const STORAGE_KEY =
    'myAiCoder.sessions';

const API_URL =
    'http://127.0.0.1:8000/chat';

// ============================================================
// Tools
// ============================================================

const TOOLS = [
    {
        type: 'function',

        function: {
            name: 'read_file',

            description:
                'Read the complete text contents of a file. Path may be absolute or relative to the workspace root.',

            parameters: {
                type: 'object',

                properties: {
                    path: {
                        type: 'string',
                        description:
                            'Absolute or workspace-relative file path'
                    }
                },

                required: [
                    'path'
                ]
            }
        }
    },

    {
        type: 'function',

        function: {
            name: 'write_file',

            description:
                'Create or completely overwrite a file with the supplied content. Creates parent directories when necessary.',

            parameters: {
                type: 'object',

                properties: {
                    path: {
                        type: 'string',
                        description:
                            'Absolute or workspace-relative file path'
                    },

                    content: {
                        type: 'string',
                        description:
                            'Complete new file content'
                    }
                },

                required: [
                    'path',
                    'content'
                ]
            }
        }
    },

    {
        type: 'function',

        function: {
            name: 'list_directory',

            description:
                'List files and directories inside a directory.',

            parameters: {
                type: 'object',

                properties: {
                    path: {
                        type: 'string',
                        description:
                            'Absolute or workspace-relative directory path'
                    }
                },

                required: [
                    'path'
                ]
            }
        }
    },

    {
        type: 'function',

        function: {
            name: 'run_terminal_command',

            description:
                'Run a shell command in the workspace root.',

            parameters: {
                type: 'object',

                properties: {
                    command: {
                        type: 'string',
                        description:
                            'Shell command to execute'
                    }
                },

                required: [
                    'command'
                ]
            }
        }
    }
];

// ============================================================
// Provider
// ============================================================

class ChatViewProvider
    implements vscode.WebviewViewProvider {

    public static readonly viewType =
        'myAiCoder.chatView';

    private _view?:
        vscode.WebviewView;

    private sessions:
        ChatSession[];

    private currentSession:
        ChatSession;

    private agent:
        AgentState = {
            running:
                false,

            stopped:
                false,

            activities:
                []
        };

    private activeProcesses:
        Set<ChildProcess> =
        new Set();

    constructor(
        private readonly _extensionUri:
            vscode.Uri,

        private readonly _context:
            vscode.ExtensionContext
    ) {

        this.sessions =
            this._context.globalState.get<
                ChatSession[]
            >(
                STORAGE_KEY,
                []
            );

        this.currentSession =
            this.createSession();
    }

    // ========================================================
    // Webview
    // ========================================================

    public resolveWebviewView(
        webviewView:
            vscode.WebviewView
    ): void {

        this._view =
            webviewView;

        webviewView.webview.options = {
            enableScripts:
                true,

            localResourceRoots: [
                vscode.Uri.joinPath(
                    this._extensionUri,
                    'media'
                )
            ]
        };

        webviewView.webview.html =
            this.getHtml(
                webviewView.webview
            );

        webviewView.webview.onDidReceiveMessage(
            async (
                message
            ) => {

                switch (
                    message.type
                ) {

                    case 'sendMessage':

                        await this.handleUserMessage(
                            String(
                                message.text ||
                                ''
                            )
                        );

                        break;

                    case 'stopAgent':

                        this.stopAgent();

                        break;

                    case 'newChat':

                        this.startNewChat();

                        break;

                    case 'showHistory':

                        await this.showHistory();

                        break;

                    case 'requestState':

                        this.sendFullState();

                        break;
                }
            }
        );

        this.sendFullState();
    }

    // ========================================================
    // UI
    // ========================================================

    private post(
        message:
            any
    ): void {

        if (!this._view) {
            return;
        }

        void this._view.webview.postMessage(
            message
        );
    }

    private addActivity(
        data:
            Omit<
                ActivityItem,
                'id' | 'timestamp'
            >
    ): ActivityItem {

        const item:
            ActivityItem = {
                ...data,

                id:
                    randomUUID(),

                timestamp:
                    Date.now()
            };

        this.agent.activities.push(
            item
        );

        this.post({
            type:
                'activity',

            activity:
                item
        });

        return item;
    }

    private updateActivity(
        id:
            string,

        update:
            Partial<ActivityItem>
    ): void {

        const index =
            this.agent.activities.findIndex(
                item =>
                    item.id === id
            );

        if (index === -1) {
            return;
        }

        this.agent.activities[index] = {
            ...this.agent.activities[index],
            ...update
        };

        this.post({
            type:
                'activityUpdate',

            activity:
                this.agent.activities[index]
        });
    }

    private sendFullState(): void {

        const messages =
            this.currentSession.messages.filter(
                message => {

                    if (
                        message.role ===
                        'user'
                    ) {
                        return true;
                    }

                    if (
                        message.role ===
                        'assistant'
                    ) {
                        return (
                            message.content !==
                            null &&
                            message.content !==
                            ''
                        );
                    }

                    return false;
                }
            );

        this.post({
            type:
                'state',

            running:
                this.agent.running,

            stopped:
                this.agent.stopped,

            activities:
                this.agent.activities,

            messages:
                messages
        });
    }

    // ========================================================
    // Sessions
    // ========================================================

    private createSession():
        ChatSession {

        return {
            id:
                randomUUID(),

            title:
                'New Chat',

            messages:
                [],

            updatedAt:
                Date.now()
        };
    }

    private saveSessions():
        void {

        void this._context.globalState.update(
            STORAGE_KEY,
            this.sessions
        );
    }

    private persistCurrentSession():
        void {

        if (
            this.currentSession.messages.length ===
            0
        ) {
            return;
        }

        const index =
            this.sessions.findIndex(
                session =>
                    session.id ===
                    this.currentSession.id
            );

        if (index >= 0) {

            this.sessions[index] =
                this.currentSession;

        } else {

            this.sessions.unshift(
                this.currentSession
            );
        }

        this.sessions.sort(
            (
                a,
                b
            ) =>
                b.updatedAt -
                a.updatedAt
        );

        this.saveSessions();
    }

    public startNewChat():
        void {

        if (
            this.agent.running
        ) {
            return;
        }

        this.persistCurrentSession();

        this.currentSession =
            this.createSession();

        this.agent = {
            running:
                false,

            stopped:
                false,

            activities:
                []
        };

        this.sendFullState();
    }

    public async showHistory():
        Promise<void> {

        if (
            this.agent.running
        ) {
            return;
        }

        this.persistCurrentSession();

        if (
            this.sessions.length ===
            0
        ) {

            await vscode.window.showInformationMessage(
                'No past conversations yet.'
            );

            return;
        }

        const items =
            this.sessions.map(
                session => ({
                    label:
                        session.title,

                    description:
                        new Date(
                            session.updatedAt
                        ).toLocaleString(),

                    id:
                        session.id
                })
            );

        const selected =
            await vscode.window.showQuickPick(
                items,
                {
                    placeHolder:
                        'Select a past conversation'
                }
            );

        if (!selected) {
            return;
        }

        const session =
            this.sessions.find(
                item =>
                    item.id ===
                    selected.id
            );

        if (!session) {
            return;
        }

        this.currentSession =
            session;

        this.sendFullState();
    }

    // ========================================================
    // Workspace
    // ========================================================

    private getWorkspaceRoot():
        string {

        const folders =
            vscode.workspace.workspaceFolders;

        if (
            folders &&
            folders.length >
            0
        ) {

            return folders[0]
                .uri
                .fsPath;
        }

        return process.cwd();
    }

    private resolvePath(
        value:
            string
    ):
        string {

        if (
            path.isAbsolute(
                value
            )
        ) {

            return path.normalize(
                value
            );
        }

        return path.normalize(
            path.join(
                this.getWorkspaceRoot(),
                value
            )
        );
    }

    // ========================================================
    // Permission
    // ========================================================

    private async confirmAction(
        message:
            string
    ):
        Promise<boolean> {

        const autoApprove =
            vscode.workspace
                .getConfiguration(
                    'myAiCoder'
                )
                .get<boolean>(
                    'autoApprove',
                    false
                );

        if (
            autoApprove
        ) {
            return true;
        }

        const answer =
            await vscode.window.showWarningMessage(
                message,
                {
                    modal:
                        true
                },

                'Allow',
                'Deny'
            );

        return (
            answer ===
            'Allow'
        );
    }

    // ========================================================
    // Write file
    // ========================================================

    private async writeFileLive(
        fullPath:
            string,

        content:
            string
    ):
        Promise<void> {

        await fs.mkdir(
            path.dirname(
                fullPath
            ),
            {
                recursive:
                    true
            }
        );

        const uri =
            vscode.Uri.file(
                fullPath
            );

        const openDocument =
            vscode.workspace.textDocuments.find(
                document =>
                    document.uri.fsPath
                        .toLowerCase() ===
                    fullPath
                        .toLowerCase()
            );

        if (
            openDocument
        ) {

            const oldText =
                openDocument.getText();

            const fullRange =
                new vscode.Range(
                    openDocument.positionAt(
                        0
                    ),

                    openDocument.positionAt(
                        oldText.length
                    )
                );

            const edit =
                new vscode.WorkspaceEdit();

            edit.replace(
                uri,
                fullRange,
                content
            );

            await vscode.workspace.applyEdit(
                edit
            );

            await openDocument.save();

        } else {

            await fs.writeFile(
                fullPath,
                content,
                'utf8'
            );
        }

        this.post({
            type:
                'fileChanged',

            path:
                fullPath
        });
    }

    // ========================================================
    // Terminal
    // ========================================================

    private async runTerminal(
        command:
            string
    ):
        Promise<string> {

        const approved =
            await this.confirmAction(
                `Allow My AI Coder to run this command?\n\n${command}`
            );

        if (!approved) {

            return (
                'The user denied permission to run this command.'
            );
        }

        const activity =
            this.addActivity({
                type:
                    'terminal',

                title:
                    command,

                detail:
                    'Running...',

                status:
                    'running',

                toolName:
                    'run_terminal_command'
            });

        return new Promise(
            resolve => {

                const shell =
                    process.platform ===
                    'win32'
                        ? 'cmd.exe'
                        : '/bin/sh';

                const args =
                    process.platform ===
                    'win32'
                        ? [
                            '/d',
                            '/s',
                            '/c',
                            command
                        ]
                        : [
                            '-c',
                            command
                        ];

                const child =
                    spawn(
                        shell,
                        args,
                        {
                            cwd:
                                this.getWorkspaceRoot(),

                            env:
                                process.env,

                            windowsHide:
                                true
                        }
                    );

                this.activeProcesses.add(
                    child
                );

                let output =
                    '';

                const onData =
                    (
                        chunk:
                            Buffer | string
                    ) => {

                        const text =
                            chunk.toString();

                        output +=
                            text;

                        this.post({
                            type:
                                'terminalOutput',

                            activityId:
                                activity.id,

                            text:
                                text
                        });

                        this.updateActivity(
                            activity.id,
                            {
                                detail:
                                    output
                            }
                        );
                    };

                child.stdout?.on(
                    'data',
                    onData
                );

                child.stderr?.on(
                    'data',
                    onData
                );

                child.on(
                    'error',
                    error => {

                        output +=
                            `\n${error.message}`;

                        this.updateActivity(
                            activity.id,
                            {
                                status:
                                    'failed',

                                detail:
                                    output
                            }
                        );

                        this.activeProcesses.delete(
                            child
                        );

                        resolve(
                            output
                        );
                    }
                );

                child.on(
                    'close',
                    code => {

                        const result =
                            output +
                            `\n\nProcess exited with code ${
                                code ?? 0
                            }.`;

                        this.updateActivity(
                            activity.id,
                            {
                                status:
                                    code ===
                                    0
                                        ? 'completed'
                                        : 'failed',

                                detail:
                                    result
                            }
                        );

                        this.activeProcesses.delete(
                            child
                        );

                        resolve(
                            result
                        );
                    }
                );
            }
        );
    }

    // ========================================================
    // Tools
    // ========================================================

    private async executeTool(
        call:
            ToolCall
    ):
        Promise<string> {

        let args:
            any;

        try {

            args =
                JSON.parse(
                    call.function.arguments ||
                    '{}'
                );

        } catch (
            error
        ) {

            return (
                `Invalid JSON arguments: ${String(error)}`
            );
        }

        const activity =
            this.addActivity({
                type:
                    'tool',

                title:
                    call.function.name,

                detail:
                    JSON.stringify(
                        args,
                        null,
                        2
                    ),

                status:
                    'running',

                toolName:
                    call.function.name,

                args:
                    args
            });

        try {

            switch (
                call.function.name
            ) {

                case 'read_file': {

                    const fullPath =
                        this.resolvePath(
                            String(
                                args.path
                            )
                        );

                    const content =
                        await fs.readFile(
                            fullPath,
                            'utf8'
                        );

                    this.updateActivity(
                        activity.id,
                        {
                            status:
                                'completed',

                            detail:
                                fullPath
                        }
                    );

                    return content;
                }

                case 'write_file': {

                    const fullPath =
                        this.resolvePath(
                            String(
                                args.path
                            )
                        );

                    const approved =
                        await this.confirmAction(
                            `Allow My AI Coder to write:\n${fullPath}?`
                        );

                    if (
                        !approved
                    ) {

                        this.updateActivity(
                            activity.id,
                            {
                                status:
                                    'failed',

                                detail:
                                    'Permission denied.'
                            }
                        );

                        return (
                            'The user denied permission to write this file.'
                        );
                    }

                    await this.writeFileLive(
                        fullPath,

                        String(
                            args.content ??
                            ''
                        )
                    );

                    this.updateActivity(
                        activity.id,
                        {
                            title:
                                `Updated ${args.path}`,

                            status:
                                'completed',

                            detail:
                                fullPath
                        }
                    );

                    return (
                        `File written successfully: ${fullPath}`
                    );
                }

                case 'list_directory': {

                    const fullPath =
                        this.resolvePath(
                            String(
                                args.path
                            )
                        );

                    const entries =
                        await fs.readdir(
                            fullPath,
                            {
                                withFileTypes:
                                    true
                            }
                        );

                    const listing =
                        entries
                            .map(
                                entry =>
                                    entry.isDirectory()
                                        ? `${entry.name}/`
                                        : entry.name
                            )
                            .join('\n');

                    this.updateActivity(
                        activity.id,
                        {
                            status:
                                'completed',

                            detail:
                                listing
                        }
                    );

                    return (
                        listing ||
                        '(empty directory)'
                    );
                }

                case 'run_terminal_command': {

                    const result =
                        await this.runTerminal(
                            String(
                                args.command ??
                                ''
                            )
                        );

                    this.updateActivity(
                        activity.id,
                        {
                            status:
                                'completed',

                            detail:
                                result
                        }
                    );

                    return result;
                }

                default: {

                    const result =
                        `Unknown tool: ${call.function.name}`;

                    this.updateActivity(
                        activity.id,
                        {
                            status:
                                'failed',

                            detail:
                                result
                        }
                    );

                    return result;
                }
            }

        } catch (
            error
        ) {

            const result =
                `Tool failed: ${String(error)}`;

            this.updateActivity(
                activity.id,
                {
                    status:
                        'failed',

                    detail:
                        result
                }
            );

            return result;
        }
    }

    // ========================================================
    // Stop
    // ========================================================

    public stopAgent():
        void {

        if (
            !this.agent.running
        ) {
            return;
        }

        this.agent.stopped =
            true;

        for (
            const child
            of this.activeProcesses
        ) {

            try {
                child.kill();
            } catch {
                // Already closed.
            }
        }

        this.activeProcesses.clear();

        this.agent.running =
            false;

        this.addActivity({
            type:
                'status',

            title:
                'Stopped',

            detail:
                'Agent stopped by user.',

            status:
                'info'
        });

        this.post({
            type:
                'agentStopped'
        });
    }

    // ========================================================
    // User message
    // ========================================================

    private async handleUserMessage(
        text:
            string
    ):
        Promise<void> {

        const value =
            text.trim();

        if (
            !value
        ) {
            return;
        }

        if (
            this.agent.running
        ) {
            return;
        }

        this.currentSession.messages.push({
            role:
                'user',

            content:
                value
        });

        this.currentSession.updatedAt =
            Date.now();

        if (
            this.currentSession.title ===
            'New Chat'
        ) {

            this.currentSession.title =
                value.length >
                50
                    ? value.slice(
                        0,
                        50
                    ) + '...'
                    : value;
        }

        this.agent = {
            running:
                true,

            stopped:
                false,

            activities:
                []
        };

        this.persistCurrentSession();

        this.post({
            type:
                'userMessage',

            text:
                value
        });

        this.post({
            type:
                'agentStarted'
        });

        try {

            await this.runAgent();

        } catch (
            error
        ) {

            const text =
                String(error);

            this.agent.running =
                false;

            this.addActivity({
                type:
                    'error',

                title:
                    'Agent error',

                detail:
                    text,

                status:
                    'failed'
            });

            this.post({
                type:
                    'error',

                text:
                    text
            });
        }
    }

    // ========================================================
    // Agent loop
    // ========================================================

    private async runAgent():
        Promise<void> {

        while (
            this.agent.running &&
            !this.agent.stopped
        ) {

            console.log(
                '[My AI Coder] Sending model request...'
            );

            const response =
                await axios.post(
                    API_URL,
                    {
                        messages:
                            this.currentSession.messages,

                        tools:
                            TOOLS,

                        model:
                            undefined
                    },
                    {
                        timeout:
                            0,

                        validateStatus:
                            () => true
                    }
                );

            // ------------------------------------------------
            // HTTP error
            // ------------------------------------------------

            if (
                response.status < 200 ||
                response.status >= 300
            ) {

                const detail =
                    response.data?.detail ||
                    `HTTP ${response.status}`;

                throw new Error(
                    detail
                );
            }

            const message =
                response.data?.message;

            if (
                !message
            ) {

                throw new Error(
                    'The server returned no assistant message.'
                );
            }

            console.log(
                '[My AI Coder] Model response received:',
                {
                    hasContent:
                        message.content !==
                        undefined,

                    toolCalls:
                        message.tool_calls?.length ||
                        0
                }
            );

            // ------------------------------------------------
            // Tool calls
            // ------------------------------------------------

            if (
                Array.isArray(
                    message.tool_calls
                ) &&
                message.tool_calls.length >
                0
            ) {

                /*
                 * Persist assistant tool-call message FIRST.
                 */

                this.currentSession.messages.push({
                    role:
                        'assistant',

                    content:
                        message.content ??
                        null,

                    tool_calls:
                        message.tool_calls
                });

                this.persistCurrentSession();

                /*
                 * Execute EVERY tool call.
                 */

                for (
                    const call
                    of message.tool_calls
                ) {

                    let result:
                        string;

                    if (
                        this.agent.stopped
                    ) {

                        result =
                            'Agent stopped by user.';

                    } else {

                        result =
                            await this.executeTool(
                                call
                            );
                    }

                    /*
                     * ALWAYS add the matching tool result.
                     */

                    this.currentSession.messages.push({
                        role:
                            'tool',

                        tool_call_id:
                            call.id,

                        content:
                            result
                    });

                    this.currentSession.updatedAt =
                        Date.now();

                    this.persistCurrentSession();
                }

                if (
                    this.agent.stopped
                ) {

                    return;
                }

                /*
                 * Continue with next model request.
                 */

                continue;
            }

            // ------------------------------------------------
            // Final response
            // ------------------------------------------------

            const answer =
                typeof message.content ===
                'string'
                    ? message.content
                    : '';

            this.currentSession.messages.push({
                role:
                    'assistant',

                content:
                    answer
            });

            this.currentSession.updatedAt =
                Date.now();

            this.persistCurrentSession();

            this.agent.running =
                false;

            this.addActivity({
                type:
                    'result',

                title:
                    'Completed',

                detail:
                    answer,

                status:
                    'completed'
            });

            this.post({
                type:
                    'assistantMessage',

                text:
                    answer
            });

            this.post({
                type:
                    'agentFinished'
            });

            return;
        }
    }

    // ========================================================
    // HTML
    // ========================================================

    private getHtml(
        webview:
            vscode.Webview
    ):
        string {

        const scriptUri =
            webview.asWebviewUri(
                vscode.Uri.joinPath(
                    this._extensionUri,
                    'media',
                    'main.js'
                )
            );

        const styleUri =
            webview.asWebviewUri(
                vscode.Uri.joinPath(
                    this._extensionUri,
                    'media',
                    'main.css'
                )
            );

        const nonce =
            getNonce();

        return `
<!DOCTYPE html>

<html lang="en">

<head>

    <meta charset="UTF-8">

    <meta
        http-equiv="Content-Security-Policy"
        content="
            default-src 'none';
            style-src ${webview.cspSource};
            script-src 'nonce-${nonce}';
        "
    >

    <link
        href="${styleUri}"
        rel="stylesheet"
    >

    <title>
        My AI Coder
    </title>

</head>

<body>

    <header id="header">

        <div id="title">
            My AI Coder
        </div>

        <div id="header-actions">

            <button
                id="new-chat"
            >
                +
            </button>

            <button
                id="history"
            >
                History
            </button>

        </div>

    </header>

    <main id="chat"></main>

    <section
        id="activity-section"
    >

        <div
            id="activity-header"
            class="hidden"
        >

            <span
                id="activity-status"
            >
                Working...
            </span>

            <button
                id="stop"
            >
                Stop
            </button>

        </div>

        <div
            id="activity"
        ></div>

    </section>

    <footer
        id="input-area"
    >

        <textarea
            id="input"
            rows="1"
            placeholder="Ask My AI Coder..."
        ></textarea>

        <button
            id="send"
        >
            Send
        </button>

    </footer>

    <script
        nonce="${nonce}"
        src="${scriptUri}"
    ></script>

</body>

</html>
`;
    }
}

// ============================================================
// Nonce
// ============================================================

function getNonce():
    string {

    let text =
        '';

    const possible =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    for (
        let i = 0;
        i < 32;
        i++
    ) {

        text +=
            possible.charAt(
                Math.floor(
                    Math.random() *
                    possible.length
                )
            );
    }

    return text;
}

// ============================================================
// Activate
// ============================================================

export function activate(
    context:
        vscode.ExtensionContext
):
    void {

    const provider =
        new ChatViewProvider(
            context.extensionUri,
            context
        );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden:
                        true
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'my-ai-coder.newChat',
            () => {
                provider.startNewChat();
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'my-ai-coder.showHistory',
            () => {
                void provider.showHistory();
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'my-ai-coder.stopAgent',
            () => {
                provider.stopAgent();
            }
        )
    );
}

export function deactivate():
    void {
}