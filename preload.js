const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rocketLeague", {
    onPlayersUpdated(callback) {
        const listener = (_event, players) => {
            callback(players);
        };

        ipcRenderer.on("players-updated", listener);

        // Allow the page to unsubscribe if necessary.
        return () => {
            ipcRenderer.removeListener("players-updated", listener);
        };
    },
    onHeatmapUpdated(callback) {
        const listener = (_event, samples) => {
            callback(samples);
        };

        ipcRenderer.on("heatmap-updated", listener);
        return () => {
            ipcRenderer.removeListener("heatmap-updated", listener);
        };
    },
    onMatchHistoryUpdated(callback) {
        const listener = (_event, history) => {
            callback(history);
        };

        ipcRenderer.on("match-history-updated", listener);
        return () => {
            ipcRenderer.removeListener("match-history-updated", listener);
        };
    },
    onOverlayViewUpdated(callback) {
        const listener = (_event, view) => {
            callback(view);
        };

        ipcRenderer.on("overlay-view-updated", listener);
        return () => {
            ipcRenderer.removeListener("overlay-view-updated", listener);
        };
    },
    onConnectionStatusUpdated(callback) {
        const listener = (_event, status) => {
            callback(status);
        };

        ipcRenderer.on("connection-status-updated", listener);

        return () => {
            ipcRenderer.removeListener("connection-status-updated", listener);
        };
    },
    setApiConnectionEnabled(enabled) {
        ipcRenderer.send("set-api-connection", enabled);
    },
    toggleSettingsWindow() {
        ipcRenderer.send("toggle-settings-window");
    },
    sendGamepadButtonChange(data) {
        ipcRenderer.send("gamepad-button-change", data);
    },
    onSettingsUpdated(callback) {
        const listener = (_event, settings) => {
            callback(settings);
        };

        ipcRenderer.on("settings-updated", listener);
        return () => {
            ipcRenderer.removeListener("settings-updated", listener);
        };
    },
    getSettings() {
        return ipcRenderer.invoke("get-settings");
    },
    saveSettings(settings) {
        return ipcRenderer.invoke("save-settings", settings);
    },
    checkForUpdates() {
        return ipcRenderer.invoke("check-for-updates");
    },
    installDownloadedUpdate() {
        return ipcRenderer.invoke("install-downloaded-update");
    },
    closeApp() {
        return ipcRenderer.invoke("close-app");
    },
    onAppUpdateStatus(callback) {
        const listener = (_event, status) => {
            callback(status);
        };

        ipcRenderer.on("app-update-status", listener);
        return () => {
            ipcRenderer.removeListener("app-update-status", listener);
        };
    },
    startGamepadBinding(target) {
        ipcRenderer.send("start-gamepad-binding", target);
    },
    cancelGamepadBinding() {
        ipcRenderer.send("cancel-gamepad-binding");
    },
    onGamepadBindingResult(callback) {
        const listener = (_event, result) => {
            callback(result);
        };

        ipcRenderer.on("gamepad-binding-result", listener);
        return () => {
            ipcRenderer.removeListener("gamepad-binding-result", listener);
        };
    },
    onSettingsFilePath(callback) {
        const listener = (_event, filePath) => {
            callback(filePath);
        };

        ipcRenderer.on("settings-file-path", listener);
        return () => {
            ipcRenderer.removeListener("settings-file-path", listener);
        };
    },
    onMatchHistoryFilePath(callback) {
        const listener = (_event, filePath) => {
            callback(filePath);
        };

        ipcRenderer.on("match-history-file-path", listener);
        return () => {
            ipcRenderer.removeListener("match-history-file-path", listener);
        };
    },
    getImposterSession() {
        return ipcRenderer.invoke("get-imposter-session");
    },
    saveImposterSession(session) {
        return ipcRenderer.invoke("save-imposter-session", session);
    },
    openImposterWindow(session) {
        return ipcRenderer.invoke("open-imposter-window", session);
    },
    closeImposterWindow() {
        return ipcRenderer.invoke("close-imposter-window");
    },
    onImposterMatchEnded(callback) {
        const listener = () => callback();
        ipcRenderer.on("imposter-match-ended", listener);
        return () => ipcRenderer.removeListener("imposter-match-ended", listener);
    },
    onImposterGameStats(callback) {
        const listener = (_event, stats) => callback(stats);
        ipcRenderer.on("imposter-game-stats", listener);
        return () => ipcRenderer.removeListener("imposter-game-stats", listener);
    }
});