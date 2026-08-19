import * as vscode from 'vscode';
import axios from 'axios';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

interface ChatSession {
    id: string;
    title: string;
    messages: ChatMessage[];
    updatedAt: number;
}

const STORAGE_KEY = 'myAiCoder.sessions';
const MAX_TITLE_LENGTH = 50;
const MAX_TOOL_ROUNDS = 10;
const MAX_TOOL_OUTPUT_CHARS = 8000;

// ------------------------------------------------------------
// Tool definitions sent to the model (OpenAI function-calling format)
// ------------------------------------------------------------

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the text contents of a file. Path may be absolute or relative to the workspace root.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute or workspace-relative file path' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Create or overwrite a file with the given content. Creates parent folders if needed.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute or workspace-relative file path' },
                    content: { type: 'string', description: 'Full new content of the file' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List files and subfolders inside a directory.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute or workspace-relative directory path' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_terminal_command',
            description: 'Run a shell command in the workspace root and return stdout/stderr.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The shell command to run' }
                },
                required: ['command']
            }
        }
    }
];

// ------------------------------------------------------------
// Provider
// ------------------------------------------------------------

class ChatViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'myAiCoder.chatView';

    private _view?: vscode.WebviewView;
    private sessions: ChatSession[];
    private currentSession: ChatSession;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this.sessions = this._context.globalState.get<ChatSession[]>(STORAGE_KEY, []);
        this.currentSession = this.createSession();
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media')
            ]
        };

        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'sendMessage':
                    await this.handleUserMessage(message.text);
                    break;
                case 'newChat':
                    this.startNewChat();
                    break;
            }
        });
    }

    // ------------------------------------------------------------
    // Session management
    // ------------------------------------------------------------

    private createSession(): ChatSession {
        return {
            id: randomUUID(),
            title: 'New Chat',
            messages: [],
            updatedAt: Date.now()
        };
    }

    private saveSessions() {
        this._context.globalState.update(STORAGE_KEY, this.sessions);
    }

    private persistCurrentSession() {
        if (this.currentSession.messages.length === 0) {
            return;
        }

        const existingIndex = this.sessions.findIndex(
            (s) => s.id === this.currentSession.id
        );

        if (existingIndex >= 0) {
            this.sessions[existingIndex] = this.currentSession;
        } else {
            this.sessions.unshift(this.currentSession);
        }

        this.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        this.saveSessions();
    }

    public startNewChat() {
        this.persistCurrentSession();
        this.currentSession = this.createSession();
        this._view?.webview.postMessage({ type: 'cleared' });
    }

    public async showHistory() {
        this.persistCurrentSession();

        if (this.sessions.length === 0) {
            vscode.window.showInformationMessage('No past conversations yet.');
            return;
        }

        const items = this.sessions.map((s) => ({
            label: s.title,
            description: new Date(s.updatedAt).toLocaleString(),
            id: s.id
        }));

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a past conversation to reopen'
        });

        if (picked) {
            this.loadSession(picked.id);
        }
    }

    private loadSession(id: string) {
        const session = this.sessions.find((s) => s.id === id);
        if (!session) {
            return;
        }

        this.persistCurrentSession();
        this.currentSession = session;

        this._view?.webview.postMessage({
            type: 'restore',
            // Only replay real text turns as bubbles; tool plumbing stays out of the UI history
            messages: this.currentSession.messages.filter(
                (m) => (m.role === 'user' || m.role === 'assistant') && m.content
            )
        });
    }

    // ------------------------------------------------------------
    // Workspace helpers
    // ------------------------------------------------------------

    private resolvePath(inputPath: string): string {
        if (path.isAbsolute(inputPath)) {
            return inputPath;
        }

        const folders = vscode.workspace.workspaceFolders;
        const root = folders && folders.length > 0
            ? folders[0].uri.fsPath
            : process.cwd();

        return path.join(root, inputPath);
    }

    private getWorkspaceRoot(): string {
        const folders = vscode.workspace.workspaceFolders;
        return folders && folders.length > 0
            ? folders[0].uri.fsPath
            : process.cwd();
    }

    private async confirmAction(message: string): Promise<boolean> {
        const autoApprove = vscode.workspace
            .getConfiguration('myAiCoder')
            .get<boolean>('autoApprove', false);

        if (autoApprove) {
            return true;
        }

        const choice = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            'Allow',
            'Deny'
        );

        return choice === 'Allow';
    }

    private truncate(text: string): string {
        if (text.length <= MAX_TOOL_OUTPUT_CHARS) {
            return text;
        }
        return text.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n...[truncated]';
    }

    // ------------------------------------------------------------
    // Tool execution
    // ------------------------------------------------------------

    private async executeTool(toolCall: ToolCall): Promise<string> {
        const { name, arguments: argsJson } = toolCall.function;

        let args: any;
        try {
            args = JSON.parse(argsJson || '{}');
        } catch {
            return 'Error: could not parse tool arguments as JSON.';
        }

        this._view?.webview.postMessage({
            type: 'toolCall',
            name,
            args
        });

        try {
            switch (name) {

                case 'read_file': {
                    const fullPath = this.resolvePath(args.path);
                    const content = await fs.readFile(fullPath, 'utf-8');
                    return this.truncate(content);
                }

                case 'write_file': {
                    const fullPath = this.resolvePath(args.path);

                    const approved = await this.confirmAction(
                        `Allow My AI Coder to write to:\n${fullPath}?`
                    );

                    if (!approved) {
                        return 'The user denied permission to write this file.';
                    }

                    await fs.mkdir(path.dirname(fullPath), { recursive: true });
                    await fs.writeFile(fullPath, args.content, 'utf-8');

                    // Open/refresh the file in the editor so the user sees the change
                    const doc = await vscode.workspace.openTextDocument(fullPath);
                    await vscode.window.showTextDocument(doc, { preview: false });

                    return `File written successfully: ${fullPath}`;
                }

                case 'list_directory': {
                    const fullPath = this.resolvePath(args.path);
                    const entries = await fs.readdir(fullPath, { withFileTypes: true });
                    const listing = entries
                        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
                        .join('\n');
                    return listing || '(empty directory)';
                }

                case 'run_terminal_command': {
                    const approved = await this.confirmAction(
                        `Allow My AI Coder to run this command in the workspace?\n\n${args.command}`
                    );

                    if (!approved) {
                        return 'The user denied permission to run this command.';
                    }

                    try {
                        const { stdout, stderr } = await execAsync(args.command, {
                            cwd: this.getWorkspaceRoot(),
                            timeout: 30000,
                            maxBuffer: 1024 * 1024
                        });
                        return this.truncate(
                            `stdout:\n${stdout || '(empty)'}\n\nstderr:\n${stderr || '(empty)'}`
                        );
                    } catch (execError: any) {
                        return this.truncate(
                            `Command failed: ${execError.message}\n\nstdout:\n${execError.stdout || ''}\n\nstderr:\n${execError.stderr || ''}`
                        );
                    }
                }

                default:
                    return `Error: unknown tool "${name}".`;
            }
        } catch (err) {
            return `Error running tool "${name}": ${String(err)}`;
        }
    }

    // ------------------------------------------------------------
    // Chat handling (agent loop)
    // ------------------------------------------------------------

    private async handleUserMessage(text: string) {
        if (!text || !this._view) {
            return;
        }

        this.currentSession.messages.push({ role: 'user', content: text });
        this.currentSession.updatedAt = Date.now();

        if (this.currentSession.title === 'New Chat') {
            this.currentSession.title = text.length > MAX_TITLE_LENGTH
                ? text.slice(0, MAX_TITLE_LENGTH) + '...'
                : text;
        }

        this._view.webview.postMessage({ type: 'userMessage', text });
        this._view.webview.postMessage({ type: 'thinking' });

        try {
            let rounds = 0;

            while (rounds < MAX_TOOL_ROUNDS) {
                rounds++;

                const response = await axios.post(
                    'http://127.0.0.1:8000/chat',
                    {
                        messages: this.currentSession.messages,
                        tools: TOOLS
                    }
                );

                const message = response.data.message as ChatMessage;

                if (message.tool_calls && message.tool_calls.length > 0) {
                    // Record the assistant's tool-call turn
                    this.currentSession.messages.push({
                        role: 'assistant',
                        content: message.content ?? null,
                        tool_calls: message.tool_calls
                    });

                    // Execute each requested tool and feed results back
                    for (const toolCall of message.tool_calls) {
                        const result = await this.executeTool(toolCall);

                        this.currentSession.messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: result
                        });

                        this._view.webview.postMessage({
                            type: 'toolResult',
                            name: toolCall.function.name,
                            result
                        });
                    }

                    // Loop again so the model can react to the tool results
                    continue;
                }

                // Final plain-text answer
                const answer = message.content ?? '';
                this.currentSession.messages.push({ role: 'assistant', content: answer });
                this.currentSession.updatedAt = Date.now();

                this._view.webview.postMessage({
                    type: 'assistantMessage',
                    text: answer
                });

                this.persistCurrentSession();
                return;
            }

            this._view.webview.postMessage({
                type: 'error',
                text: 'Stopped after too many tool-call rounds.'
            });

        } catch (error) {
            let errorText: string;
            if (axios.isAxiosError(error)) {
                errorText = error.response?.data?.detail || error.message;
            } else {
                errorText = String(error);
            }

            this._view.webview.postMessage({
                type: 'error',
                text: errorText
            });
        }
    }

    // ------------------------------------------------------------
    // Webview HTML
    // ------------------------------------------------------------

    private getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css')
        );

        const nonce = getNonce();

        return /* html */ `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy"
                    content="default-src 'none';
                             style-src ${webview.cspSource};
                             img-src ${webview.cspSource} https: data:;
                             script-src 'nonce-${nonce}';">
                <link href="${styleUri}" rel="stylesheet">
                <title>My AI Coder</title>
            </head>
            <body>
                <div id="chat"></div>

                <div id="input-area">
                    <textarea id="input" rows="1" placeholder="Ask My AI Coder..."></textarea>
                    <button id="send">Send</button>
                </div>

                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>
        `;
    }
}

function getNonce(): string {
    let text = '';
    const possible =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function activate(context: vscode.ExtensionContext) {

    const provider = new ChatViewProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            provider
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('my-ai-coder.newChat', () => {
            provider.startNewChat();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('my-ai-coder.showHistory', () => {
            provider.showHistory();
        })
    );
}

export function deactivate() {}