import React, { useEffect, useState } from "react";

function useGamepadBridge() {
    useEffect(() => {
        const api = window.rocketLeague;
        const previousButtons = new Map();
        let frameId;

        function pollGamepads() {
            if (navigator.getGamepads) {
                const currentButtons = new Map();
                for (const gamepad of navigator.getGamepads()) {
                    if (!gamepad) continue;
                    const controllerId = `${gamepad.index}|${gamepad.id}`;
                    gamepad.buttons.forEach((button, index) => {
                        const key = `${controllerId}:${index}`;
                        const pressed = button.pressed || button.value >= 0.5;
                        const state = { controllerId, index, pressed };
                        currentButtons.set(key, state);
                        if (previousButtons.get(key)?.pressed !== pressed) {
                            api.sendGamepadButtonChange({
                                controllerId,
                                button: index,
                                pressed
                            });
                        }
                    });
                }
                for (const [key, previous] of previousButtons) {
                    if (!currentButtons.has(key) && previous.pressed) {
                        api.sendGamepadButtonChange({
                            controllerId: previous.controllerId,
                            button: previous.index,
                            pressed: false
                        });
                    }
                }
                previousButtons.clear();
                for (const [key, state] of currentButtons) {
                    previousButtons.set(key, state);
                }
            }
            frameId = requestAnimationFrame(pollGamepads);
        }

        frameId = requestAnimationFrame(pollGamepads);
        return () => cancelAnimationFrame(frameId);
    }, []);
}

export default function StatusApp() {
    const [connection, setConnection] = useState({
        connected: false,
        receiving: false,
        enabled: true
    });
    const [keyboard, setKeyboard] = useState({
        toggleConnection: "F9",
        toggleSettings: "F10"
    });
    useGamepadBridge();

    useEffect(() => {
        const api = window.rocketLeague;
        const unsubscribers = [
            api.onConnectionStatusUpdated(setConnection),
            api.onSettingsUpdated((settings) => setKeyboard(settings.keyboard))
        ];
        return () => unsubscribers.forEach((unsubscribe) => unsubscribe?.());
    }, []);

    let statusText;
    if (!connection.enabled) statusText = "API connection disabled";
    else if (connection.receiving) statusText = "Receiving messages";
    else if (connection.connected) statusText = "Connected; waiting for messages";
    else statusText = "Disconnected from API";

    return (
        <main className="status-panel">
            <div className="connection-status" role="status" aria-live="polite">
                <span className={`connection-indicator${connection.receiving
                    ? " receiving"
                    : connection.connected && connection.enabled ? " waiting" : ""}`} />
                <span className="connection-status-text">{statusText}</span>
            </div>
            <div className="status-controls">
                <div className="status-control-group">
                    <button
                        type="button"
                        className={connection.enabled ? "disconnect" : ""}
                        onClick={() => window.rocketLeague.setApiConnectionEnabled(!connection.enabled)}
                    >
                        {connection.enabled ? "Disconnect" : "Connect"}
                    </button>
                    <span className="shortcut-hint">[{keyboard.toggleConnection}]</span>
                </div>
                <div className="status-control-group">
                    <button
                        type="button"
                        className="settings-button"
                        onClick={() => window.rocketLeague.toggleSettingsWindow()}
                    >
                        Settings
                    </button>
                    <span className="shortcut-hint">[{keyboard.toggleSettings}]</span>
                </div>
            </div>
        </main>
    );
}
