(function () {
    const vscode = acquireVsCodeApi();

    const chatEl = document.getElementById('chat');
    const inputEl = document.getElementById('input');
    const sendEl = document.getElementById('send');
    const stopEl = document.getElementById('stop');
    const newChatEl = document.getElementById('new-chat');
    const historyEl = document.getElementById('history');
    const activityEl = document.getElementById('activity');
    const activityHeader = document.getElementById('activity-header');
    const activityStatus = document.getElementById('activity-status');

    let running = false;

    const activityElements = new Map();

    // ============================================================
    // Helpers
    // ============================================================

    function scrollChat() {
        chatEl.scrollTop = chatEl.scrollHeight;
    }

    function scrollActivity() {
        activityEl.scrollTop = activityEl.scrollHeight;
    }

    function addBubble(text, cssClass) {
        const element = document.createElement('div');

        element.className = 'message ' + cssClass;

        element.textContent =
            text === null || text === undefined
                ? ''
                : String(text);

        chatEl.appendChild(element);

        scrollChat();

        return element;
    }

    function setRunning(value) {
        running = Boolean(value);

        if (sendEl) {
            sendEl.disabled = running;
        }

        if (inputEl) {
            inputEl.disabled = running;
        }

        if (stopEl) {
            stopEl.disabled = !running;
        }

        if (newChatEl) {
            newChatEl.disabled = running;
        }

        if (activityHeader) {
            activityHeader.classList.toggle(
                'hidden',
                !running
            );
        }

        if (activityStatus) {
            activityStatus.textContent =
                running
                    ? 'Working...'
                    : 'Finished';
        }
    }

    function clearChat() {
        chatEl.innerHTML = '';
    }

    function clearActivity() {
        activityEl.innerHTML = '';
        activityElements.clear();
    }

    function ensureActivitySectionVisible() {
        if (activityEl) {
            activityEl.style.display = '';
        }
    }

    // ============================================================
    // Activity
    // ============================================================

    function createActivity(activity) {
        if (!activity || !activity.id) {
            return;
        }

        if (activityElements.has(activity.id)) {
            updateActivity(activity);
            return;
        }

        ensureActivitySectionVisible();

        const row = document.createElement('div');
        row.className = 'activity-item';
        row.dataset.id = activity.id;

        const icon = document.createElement('div');
        icon.className = 'activity-icon';

        const body = document.createElement('div');
        body.className = 'activity-body';

        const title = document.createElement('div');
        title.className = 'activity-title';

        const detail = document.createElement('pre');
        detail.className = 'activity-detail';

        body.appendChild(title);
        body.appendChild(detail);

        row.appendChild(icon);
        row.appendChild(body);

        activityEl.appendChild(row);

        activityElements.set(activity.id, {
            row,
            icon,
            title,
            detail
        });

        updateActivity(activity);

        scrollActivity();
    }

    function updateActivity(activity) {
        if (!activity || !activity.id) {
            return;
        }

        let elements = activityElements.get(
            activity.id
        );

        if (!elements) {
            createActivity(activity);
            return;
        }

        const {
            row,
            icon,
            title,
            detail
        } = elements;

        row.classList.remove(
            'running',
            'completed',
            'failed',
            'info'
        );

        const status =
            activity.status || 'info';

        row.classList.add(status);

        title.textContent =
            activity.title || 'Activity';

        detail.textContent =
            activity.detail || '';

        if (status === 'running') {
            icon.textContent = '●';
        } else if (status === 'completed') {
            icon.textContent = '✓';
        } else if (status === 'failed') {
            icon.textContent = '×';
        } else {
            icon.textContent = '•';
        }

        scrollActivity();
    }

    function addTerminalOutput(
        activityId,
        text
    ) {
        const elements =
            activityElements.get(activityId);

        if (!elements) {
            return;
        }

        elements.detail.textContent +=
            text || '';

        scrollActivity();
    }

    // ============================================================
    // Chat rendering
    // ============================================================

    function renderMessages(messages) {
        clearChat();

        if (!Array.isArray(messages)) {
            return;
        }

        for (const message of messages) {
            if (!message) {
                continue;
            }

            const role =
                message.role === 'user'
                    ? 'user'
                    : 'assistant';

            addBubble(
                message.content,
                role
            );
        }
    }

    function renderActivities(activities) {
        clearActivity();

        if (!Array.isArray(activities)) {
            return;
        }

        for (const activity of activities) {
            createActivity(activity);
        }
    }

    // ============================================================
    // Sending
    // ============================================================

    function send() {
        const text = inputEl.value.trim();

        if (!text || running) {
            return;
        }

        inputEl.value = '';
        inputEl.style.height = 'auto';

        addBubble(text, 'user');

        vscode.postMessage({
            type: 'sendMessage',
            text
        });
    }

    // ============================================================
    // Buttons
    // ============================================================

    if (sendEl) {
        sendEl.addEventListener(
            'click',
            send
        );
    }

    if (stopEl) {
        stopEl.addEventListener(
            'click',
            function () {
                vscode.postMessage({
                    type: 'stopAgent'
                });
            }
        );
    }

    if (newChatEl) {
        newChatEl.addEventListener(
            'click',
            function () {
                vscode.postMessage({
                    type: 'newChat'
                });
            }
        );
    }

    if (historyEl) {
        historyEl.addEventListener(
            'click',
            function () {
                vscode.postMessage({
                    type: 'showHistory'
                });
            }
        );
    }

    // ============================================================
    // Input
    // ============================================================

    if (inputEl) {
        inputEl.addEventListener(
            'keydown',
            function (event) {
                if (
                    event.key === 'Enter' &&
                    !event.shiftKey
                ) {
                    event.preventDefault();
                    send();
                }
            }
        );

        inputEl.addEventListener(
            'input',
            function () {
                inputEl.style.height = 'auto';

                inputEl.style.height =
                    inputEl.scrollHeight + 'px';
            }
        );
    }

    // ============================================================
    // Messages from extension host
    // ============================================================

    window.addEventListener(
        'message',
        function (event) {
            const message = event.data;

            if (!message || !message.type) {
                return;
            }

            switch (message.type) {

                // ------------------------------------------------
                // Full state
                // ------------------------------------------------

                case 'state': {
                    renderMessages(
                        message.messages || []
                    );

                    renderActivities(
                        message.activities || []
                    );

                    setRunning(
                        Boolean(message.running)
                    );

                    break;
                }

                // ------------------------------------------------
                // Agent started
                // ------------------------------------------------

                case 'agentStarted': {
                    setRunning(true);
                    break;
                }

                // ------------------------------------------------
                // User message
                // ------------------------------------------------

                case 'userMessage': {
                    const text =
                        message.text || '';

                    const alreadyVisible =
                        Array.from(
                            chatEl.children
                        ).some(
                            element =>
                                element.textContent ===
                                text
                        );

                    if (!alreadyVisible) {
                        addBubble(
                            text,
                            'user'
                        );
                    }

                    break;
                }

                // ------------------------------------------------
                // New activity
                // ------------------------------------------------

                case 'activity': {
                    createActivity(
                        message.activity
                    );
                    break;
                }

                // ------------------------------------------------
                // Activity update
                // ------------------------------------------------

                case 'activityUpdate': {
                    updateActivity(
                        message.activity
                    );
                    break;
                }

                // ------------------------------------------------
                // Terminal streaming
                // ------------------------------------------------

                case 'terminalOutput': {
                    addTerminalOutput(
                        message.activityId,
                        message.text
                    );
                    break;
                }

                // ------------------------------------------------
                // File changed
                // ------------------------------------------------

                case 'fileChanged': {
                    showFileEvent(
                        message.path,
                        'File updated'
                    );
                    break;
                }

                // ------------------------------------------------
                // Workspace file created
                // ------------------------------------------------

                case 'workspaceFileCreated': {
                    showFileEvent(
                        message.path,
                        'File created'
                    );
                    break;
                }

                // ------------------------------------------------
                // Workspace file changed
                // ------------------------------------------------

                case 'workspaceFileChanged': {
                    showFileEvent(
                        message.path,
                        'File changed'
                    );
                    break;
                }

                // ------------------------------------------------
                // Workspace file deleted
                // ------------------------------------------------

                case 'workspaceFileDeleted': {
                    showFileEvent(
                        message.path,
                        'File deleted'
                    );
                    break;
                }

                // ------------------------------------------------
                // Assistant response
                // ------------------------------------------------

                case 'assistantMessage': {
                    addBubble(
                        message.text,
                        'assistant'
                    );

                    scrollChat();

                    break;
                }

                // ------------------------------------------------
                // Finished
                // ------------------------------------------------

                case 'agentFinished': {
                    setRunning(false);
                    break;
                }

                // ------------------------------------------------
                // Stopped
                // ------------------------------------------------

                case 'agentStopped': {
                    setRunning(false);

                    addBubble(
                        'Agent stopped.',
                        'system'
                    );

                    break;
                }

                // ------------------------------------------------
                // Error
                // ------------------------------------------------

                case 'error': {
                    setRunning(false);

                    addBubble(
                        'Error: ' +
                        (
                            message.text || ''
                        ),
                        'error'
                    );

                    break;
                }
            }
        }
    );

    // ============================================================
    // File event
    // ============================================================

    function showFileEvent(
        filePath,
        action
    ) {
        if (!activityEl) {
            return;
        }

        const normalized =
            String(filePath || '');

        const existing =
            Array.from(
                activityEl.querySelectorAll(
                    '.file-event'
                )
            ).find(
                element =>
                    element.dataset.file ===
                    normalized &&
                    element.dataset.action ===
                    action
            );

        if (existing) {
            return;
        }

        const item =
            document.createElement('div');

        item.className =
            'file-event';

        item.dataset.file =
            normalized;

        item.dataset.action =
            action;

        item.textContent =
            '✓ ' +
            action +
            ': ' +
            normalized;

        activityEl.appendChild(item);

        scrollActivity();
    }

    // ============================================================
    // Request current state
    //
    // This is important when the user switches away from the
    // Webview and later returns to it.
    // ============================================================

    function requestState() {
        vscode.postMessage({
            type: 'requestState'
        });
    }

    requestState();

})();