import * as vscode from 'vscode';
import axios from 'axios';

export function activate(context: vscode.ExtensionContext) {

    console.log('My AI Coder activated');

    const disposable = vscode.commands.registerCommand(
        'my-ai-coder.ask',
        async () => {

            const question = await vscode.window.showInputBox({
                prompt: 'Ask My AI Coder',
                placeHolder: 'Example: Explain what a Laravel controller is'
            });

            if (!question) {
                return;
            }

            try {

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'My AI Coder is thinking...'
                    },
                    async () => {

                        const result = await axios.post(
                            'http://127.0.0.1:8000/chat',
                            {
                                message: question
                            }
                        );

                        const answer = result.data.response;

                        const document =
                            await vscode.workspace.openTextDocument({
                                content: answer,
                                language: 'markdown'
                            });

                        await vscode.window.showTextDocument(document);
                    }
                );

            } catch (error: any) {

                console.error(error);

                vscode.window.showErrorMessage(
                    `My AI Coder error: ${
                        error.response?.data?.detail ||
                        error.message
                    }`
                );
            }
        }
    );

    context.subscriptions.push(disposable);
}

export function deactivate() {}