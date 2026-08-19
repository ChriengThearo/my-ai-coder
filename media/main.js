(function () {
    const vscode = acquireVsCodeApi();

    const chatEl = document.getElementById('chat');
    const inputEl = document.getElementById('input');
    const sendEl = document.getElementById('send');

    let thinkingEl = null;

    function addBubble(text, cssClass) {
        const el = document.createElement('div');
        el.className = 'message ' + cssClass;
        el.textContent = text;
        chatEl.appendChild(el);
        chatEl.scrollTop = chatEl.scrollHeight;
        return el;
    }

    function removeThinking() {
        if (thinkingEl) {
            thinkingEl.remove();
            thinkingEl = null;
        }
    }

    function send() {
        const text = inputEl.value.trim();
        if (!text) {
            return;
        }
        inputEl.value = '';
        inputEl.style.height = 'auto';
        sendEl.disabled = true;

        vscode.postMessage({ type: 'sendMessage', text });
    }

    sendEl.addEventListener('click', send);

    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    });

    inputEl.addEventListener('input', () => {
        inputEl.style.height = 'auto';
        inputEl.style.height = inputEl.scrollHeight + 'px';
    });

    window.addEventListener('message', (event) => {
        const message = event.data;

        switch (message.type) {
            case 'userMessage':
                addBubble(message.text, 'user');
                break;

            case 'thinking':
                thinkingEl = addBubble('Thinking...', 'thinking');
                break;

            case 'toolCall': {
                removeThinking();
                const argsPreview = JSON.stringify(message.args);
                addBubble('🔧 ' + message.name + '(' + argsPreview + ')', 'tool');
                thinkingEl = addBubble('Thinking...', 'thinking');
                break;
            }

            case 'toolResult': {
                // Keep the transcript readable; full output still went to the model.
                break;
            }

            case 'assistantMessage':
                removeThinking();
                addBubble(message.text, 'assistant');
                sendEl.disabled = false;
                break;

            case 'error':
                removeThinking();
                addBubble('Error: ' + message.text, 'error');
                sendEl.disabled = false;
                break;

            case 'cleared':
                chatEl.innerHTML = '';
                sendEl.disabled = false;
                break;

            case 'restore':
                chatEl.innerHTML = '';
                thinkingEl = null;
                for (const m of message.messages) {
                    addBubble(m.content, m.role === 'user' ? 'user' : 'assistant');
                }
                sendEl.disabled = false;
                break;
        }
    });
}());