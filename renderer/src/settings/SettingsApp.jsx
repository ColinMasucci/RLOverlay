import React, { useEffect, useState } from "react";
import SupabasePartyApp from "../party/SupabasePartyApp.jsx";

const statOptions = [
    ["score", "Score"], ["goals", "Goals"], ["assists", "Assists"],
    ["saves", "Saves"], ["shots", "Shots"], ["demos", "Demos"],
    ["touches", "Ball touches"], ["carTouches", "Bumps"],
    ["postHits", "Post hits"], ["boostCollected", "Boost collected"],
    ["kickoffWins", "Kickoff wins"],
    ["ownGoals", "Own goals"]
];

const keyboardOptions = [
    ["toggleOverlay", "Toggle overlay"],
    ["toggleConnection", "Toggle API connection"],
    ["toggleSettings", "Open settings"],
    ["toggleHistory", "Toggle match history"]
];

function Field({ label, htmlFor, children }) {
    return (
        <div className="settings-field">
            <label htmlFor={htmlFor}>{label}</label>
            {children}
        </div>
    );
}

function RangeField({ label, name, value, min, max, step, format, onChange }) {
    return (
        <Field label={label} htmlFor={name}>
            <div className="range-control">
                <input
                    id={name}
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={(event) => onChange(Number(event.target.value))}
                />
                <span className="help">{format(value)}</span>
            </div>
        </Field>
    );
}

export default function SettingsApp() {
    const [settings, setSettings] = useState(null);
    const [statsApiConfig, setStatsApiConfig] = useState(null);
    const [packetSendRateInput, setPacketSendRateInput] = useState("10");
    const [savingPacketRate, setSavingPacketRate] = useState(false);
    const [packetRateMessage, setPacketRateMessage] = useState("");
    const [playerOptions, setPlayerOptions] = useState([]);
    const [suggestedPlayerId, setSuggestedPlayerId] = useState(null);
    const [filePath, setFilePath] = useState("");
    const [historyFilePath, setHistoryFilePath] = useState("");
    const [historyError, setHistoryError] = useState("");
    const [message, setMessage] = useState("");
    const [isError, setIsError] = useState(false);
    const [saving, setSaving] = useState(false);
    const [appInfo, setAppInfo] = useState({ isPackaged: false, version: "" });
    const [updateStatus, setUpdateStatus] = useState({ state: "idle" });
    const [updateBusy, setUpdateBusy] = useState(false);
    const [closing, setClosing] = useState(false);
    const [activeTab, setActiveTab] = useState("overlay");

    useEffect(() => {
        const api = window.rocketLeague;
        const unsubscribe = [
            api.onSettingsUpdated(setSettings),
            api.onMatchHistoryUpdated(({ playerOptions: options, suggestedPlayerId: suggestion, error }) => {
                setPlayerOptions(options);
                setSuggestedPlayerId(suggestion ?? null);
                setHistoryError(error ?? "");
            }),
            api.onGamepadBindingResult((result) => {
                setMessage(result.message);
                setIsError(result.error === true);
            }),
            api.onAppUpdateStatus((status) => {
                setUpdateStatus(status);
                setUpdateBusy(status.state === "checking" || status.state === "downloading");
            }),
            api.onSettingsFilePath(setFilePath),
            api.onMatchHistoryFilePath(setHistoryFilePath)
        ];
        let mounted = true;
        api.getSettings().then((result) => {
            if (!mounted) return;
            setSettings(result.settings);
            setPlayerOptions(result.playerOptions);
            setSuggestedPlayerId(result.suggestedPlayerId ?? null);
            setAppInfo(result.appInfo);
            setFilePath(`Saved to: ${result.filePath}`);
            setHistoryFilePath(`Match history file: ${result.historyFilePath}`);
        }).catch((error) => {
            if (!mounted) return;
            setMessage(`Could not load settings: ${error.message}`);
            setIsError(true);
        });
        api.getStatsApiConfig().then((result) => {
            if (!mounted) return;
            setStatsApiConfig(result);
            if (Number.isInteger(result.rate)) {
                setPacketSendRateInput(String(result.rate));
            }
            if (result.error) {
                setPacketRateMessage(`Could not load Rocket League API config: ${result.error}`);
            }
        }).catch((error) => {
            if (!mounted) return;
            setStatsApiConfig({ error: error.message });
            setPacketRateMessage(`Could not load Rocket League API config: ${error.message}`);
        });
        return () => {
            mounted = false;
            unsubscribe.forEach((dispose) => dispose?.());
            api.cancelGamepadBinding();
        };
    }, []);

    useEffect(() => {
        if (!settings || settings.trackedPlayerId ||
            settings.trackedPlayerAutoSelectDisabled || !suggestedPlayerId ||
            !playerOptions.some((player) => player.id === suggestedPlayerId)) {
            return;
        }
        void save({ ...settings, trackedPlayerId: suggestedPlayerId });
    }, [settings, suggestedPlayerId, playerOptions]);

    if (!settings) {
        return (
            <main>
                <h1>Overlay Settings</h1>
                <p className={`settings-message${isError ? " error" : ""}`}>
                    {message || "Loading settings..."}
                </p>
            </main>
        );
    }

    const updateKeyboard = (key, value) => setSettings((current) => ({
        ...current,
        keyboard: { ...current.keyboard, [key]: value }
    }));
    const updateGamepad = (key, value) => setSettings((current) => ({
        ...current,
        gamepad: { ...current.gamepad, [key]: value }
    }));
    const updateStat = (key, value) => setSettings((current) => ({
        ...current,
        statVisibility: { ...current.statVisibility, [key]: value }
    }));

    async function save(nextSettings = settings) {
        setSaving(true);
        setMessage("Saving...");
        setIsError(false);
        try {
            const result = await window.rocketLeague.saveSettings(nextSettings);
            if (!result.ok) {
                setMessage(result.error);
                setIsError(true);
                return;
            }
            setSettings(nextSettings);
            setMessage("Settings saved.");
        } catch (error) {
            setMessage(`Could not save settings: ${error.message}`);
            setIsError(true);
        } finally {
            setSaving(false);
        }
    }

    function bindGamepad(target) {
        setMessage("Press the controller button you want to assign.");
        setIsError(false);
        window.rocketLeague.startGamepadBinding(target);
    }

    async function checkForUpdates() {
        setUpdateBusy(true);
        setUpdateStatus({ state: "checking" });
        try {
            const result = await window.rocketLeague.checkForUpdates();
            if (!result.ok) {
                setUpdateBusy(false);
                setUpdateStatus({ state: "error", message: result.error });
            }
        } catch (error) {
            setUpdateBusy(false);
            setUpdateStatus({ state: "error", message: error.message });
        }
    }

    async function installUpdate() {
        try {
            const result = await window.rocketLeague.installDownloadedUpdate();
            if (!result.ok) {
                setUpdateStatus({ state: "error", message: result.error });
            }
        } catch (error) {
            setUpdateStatus({ state: "error", message: error.message });
        }
    }

    async function closeApp() {
        if (!window.confirm("Close RLOverlay?")) return;
        setClosing(true);
        try {
            const result = await window.rocketLeague.closeApp();
            if (!result.ok) {
                setClosing(false);
                setMessage(result.error);
                setIsError(true);
            }
        } catch (error) {
            setClosing(false);
            setMessage(`Could not close the app: ${error.message}`);
            setIsError(true);
        }
    }

    async function savePacketSendRate() {
        const rate = Number(packetSendRateInput);
        if (!Number.isInteger(rate) || rate < 1 || rate > 120) {
            setPacketRateMessage("Enter a whole number from 1 to 120 updates per second.");
            return;
        }
        setSavingPacketRate(true);
        setPacketRateMessage("Saving packet send rate...");
        try {
            const result = await window.rocketLeague.setStatsApiPacketRate(rate);
            if (!result.ok) {
                setPacketRateMessage(`Could not save packet send rate: ${result.error}`);
                return;
            }
            setStatsApiConfig(result);
            setPacketSendRateInput(String(result.rate));
            setPacketRateMessage(
                `Saved to ${result.filePath}. Restart Rocket League for the change to take effect.`
            );
        } catch (error) {
            setPacketRateMessage(`Could not save packet send rate: ${error.message}`);
        } finally {
            setSavingPacketRate(false);
        }
    }

    const updateMessage = {
        idle: appInfo.isPackaged
            ? "Check GitHub Releases for a newer version."
            : "Updates are available in the installed app.",
        checking: "Checking GitHub Releases...",
        downloading: `Downloading update${Number.isFinite(updateStatus.percent)
            ? `: ${updateStatus.percent}%`
            : "..."}`,
        downloaded: `Version ${updateStatus.version} is ready to install.`,
        "up-to-date": `You're up to date (version ${updateStatus.version}).`,
        error: `Update failed: ${updateStatus.message}`
    }[updateStatus.state] ?? "";
    const tabDescriptions = {
        overlay: "Customize what the in-game overlay shows and how it looks.",
        controls: "Set keyboard shortcuts and controller buttons for quick access.",
        history: "Choose your player and review local match-history options.",
        imposter: "Host or join an Imposter game. These settings are separate from the overlay.",
        app: "Check for updates or close RLOverlay."
    };
    const trackedPlayerName = playerOptions.find((player) =>
        player.id === settings.trackedPlayerId
    )?.name ?? "";

    return (
        <main>
            <h1>Overlay Settings</h1>
            <nav className="settings-tabs" aria-label="Settings sections">
                {[
                    ["overlay", "Overlay"],
                    ["controls", "Controls"],
                    ["history", "Match History"],
                    ["imposter", "Imposter"],
                    ["app", "App"]
                ].map(([tab, label]) => (
                    <button
                        key={tab}
                        type="button"
                        className={activeTab === tab ? "active" : ""}
                        aria-pressed={activeTab === tab}
                        onClick={() => setActiveTab(tab)}
                    >
                        {label}
                    </button>
                ))}
            </nav>
            <p className="settings-tab-description" aria-live="polite">
                {tabDescriptions[activeTab]}
            </p>
            <section className="settings-section" hidden={activeTab !== "controls"}>
                <h2>Keyboard shortcuts</h2>
                <p className="help">Use Electron accelerator format, such as F8 or Ctrl+Shift+O.</p>
                {keyboardOptions.map(([key, label]) => (
                    <Field key={key} label={label} htmlFor={`shortcut-${key}`}>
                        <input
                            id={`shortcut-${key}`}
                            type="text"
                            autoComplete="off"
                            spellCheck="false"
                            value={settings.keyboard[key]}
                            onChange={(event) => updateKeyboard(key, event.target.value)}
                        />
                    </Field>
                ))}
            </section>

            <section className="settings-section" hidden={activeTab !== "controls"}>
                <h2>Controller buttons</h2>
                <p className="help">
                    Hold the overlay button while pressing the history button to switch between the scoreboard and match history.
                </p>
                {[
                    ["overlayButton", "Hold to show overlay"],
                    ["toggleConnectionButton", "Toggle Rocket League connection"],
                    ["toggleHistoryButton", "Switch scoreboard / history"],
                    ["toggleSettingsButton", "Open or hide Settings"]
                ].map(([key, label]) => (
                    <div className="controller-row" key={key}>
                        <label>{label}</label>
                        <span className="binding-value">
                            {settings.gamepad[key] === null ? "Not set" : `Button ${settings.gamepad[key]}`}
                        </span>
                        <span>
                            <button type="button" onClick={() => bindGamepad(key)}>Bind</button>{" "}
                            <button
                                type="button"
                                className="secondary"
                                onClick={() => save({
                                    ...settings,
                                    gamepad: { ...settings.gamepad, [key]: null }
                                })}
                            >
                                Clear
                            </button>
                        </span>
                    </div>
                ))}
            </section>

            <section className="settings-section" hidden={activeTab !== "controls"}>
                <h2>Rocket League Stats API</h2>
                <p className="help">
                    Choose how often Rocket League sends telemetry updates. The default is 10 updates per second.
                </p>
                <Field label="Packet send rate" htmlFor="packet-send-rate">
                    <div className="packet-rate-control">
                        <input
                            id="packet-send-rate"
                            type="number"
                            min="1"
                            max="120"
                            step="1"
                            value={packetSendRateInput}
                            aria-label="Packet send rate in updates per second"
                            onChange={(event) => {
                                const { value } = event.target;
                                setPacketSendRateInput(value);
                            }}
                        />
                        <span className="help">updates/sec</span>
                    </div>
                </Field>
                <p className="help file-path">
                    {statsApiConfig?.filePath
                        ? `Config file: ${statsApiConfig.filePath}`
                        : statsApiConfig?.error
                            ? `Config unavailable: ${statsApiConfig.error}`
                            : "Loading Rocket League config..."}
                </p>
                <p className="help" role="status" aria-live="polite">
                    {packetRateMessage}
                </p>
                <button
                    type="button"
                    disabled={savingPacketRate}
                    onClick={savePacketSendRate}
                >
                    {savingPacketRate ? "Saving..." : "Save packet rate"}
                </button>
            </section>

            <section className="settings-section" hidden={activeTab !== "overlay"}>
                <h2>Appearance and display</h2>
                <RangeField
                    label="Overlay size"
                    name="overlay-scale"
                    value={settings.overlayScale}
                    min="0.8"
                    max="1.5"
                    step="0.05"
                    format={(value) => `${Math.round(value * 100)}%`}
                    onChange={(value) => setSettings((current) => ({ ...current, overlayScale: value }))}
                />
                <div className="settings-field-grid">
                    <RangeField
                        label="Horizontal position"
                        name="overlay-position-x"
                        value={settings.positionX}
                        min="-500"
                        max="500"
                        step="10"
                        format={(value) => `${value} px`}
                        onChange={(value) => setSettings((current) => ({ ...current, positionX: value }))}
                    />
                    <RangeField
                        label="Vertical position"
                        name="overlay-position-y"
                        value={settings.positionYOffset}
                        min="-500"
                        max="500"
                        step="10"
                        format={(value) => `${value} px`}
                        onChange={(value) => setSettings((current) => ({ ...current, positionYOffset: value }))}
                    />
                </div>
                <p className="help">
                    Position is measured from screen center. Positive horizontal values move right; positive vertical values move down.
                </p>
                <Field label="Show status window" htmlFor="status-window-visible">
                    <input
                        id="status-window-visible"
                        type="checkbox"
                        checked={settings.showStatusWindow}
                        onChange={(event) => setSettings((current) => ({
                            ...current, showStatusWindow: event.target.checked
                        }))}
                    />
                </Field>
                <Field label="Show ball heatmap" htmlFor="heatmap-visible">
                    <input
                        id="heatmap-visible"
                        type="checkbox"
                        checked={settings.showHeatmap}
                        onChange={(event) => setSettings((current) => ({
                            ...current, showHeatmap: event.target.checked
                        }))}
                    />
                </Field>
                <Field label="Heatmap style" htmlFor="heatmap-mode">
                    <select
                        id="heatmap-mode"
                        value={settings.heatmapMode}
                        onChange={(event) => setSettings((current) => ({
                            ...current, heatmapMode: event.target.value
                        }))}
                    >
                        <option value="overall">Overall ball heatmap</option>
                        <option value="zones">Three-zone possession</option>
                    </select>
                </Field>
                <p className="help">
                    The three-zone view splits the field into thirds and includes each team’s possession and touch shares.
                </p>
            </section>

            <section className="settings-section" hidden={activeTab !== "overlay"}>
                <h2>Scoreboard stats</h2>
                <p className="help">Choose which player stats appear on the scoreboard.</p>
                <div className="stat-options">
                    {statOptions.map(([key, label]) => (
                        <label className="stat-option" key={key}>
                            {label}
                            <input
                                type="checkbox"
                                checked={settings.statVisibility[key] !== false}
                                onChange={(event) => updateStat(key, event.target.checked)}
                            />
                        </label>
                    ))}
                </div>
            </section>

            <section className="settings-section" hidden={activeTab !== "history"}>
                <h2>Your player</h2>
                <Field label="Player to track" htmlFor="tracked-player">
                    <select
                        id="tracked-player"
                        value={settings.trackedPlayerId ?? ""}
                        onChange={(event) => setSettings((current) => ({
                            ...current,
                            trackedPlayerId: event.target.value || null,
                            trackedPlayerAutoSelectDisabled: true
                        }))}
                    >
                        <option value="">
                            {playerOptions.length ? "Choose a player" : "No players detected yet"}
                        </option>
                        {playerOptions.map((player) => (
                            <option key={player.id} value={player.id}>
                                {player.name} ({player.id})
                            </option>
                        ))}
                    </select>
                </Field>
                <p className="help">
                    Choose your player to calculate personal stats and results against opponents. Players appear after the Rocket League API detects them; matches are saved when a match ends or a new one starts.
                </p>
                {settings.trackedPlayerId === suggestedPlayerId &&
                    !settings.trackedPlayerAutoSelectDisabled && (
                        <p className="help" role="status">
                            Your player was auto-selected because they appeared in every saved match
                            (at least three matches) and were the only player to do so.
                        </p>
                    )}
                <p className="help" role="status" aria-live="polite">
                    {historyError
                        ? `History error: ${historyError}`
                        : `${playerOptions.length} player${playerOptions.length === 1 ? "" : "s"} available for tracking.`}
                </p>
                <p className="help file-path">{historyFilePath}</p>
            </section>

            <section className="settings-section" hidden={activeTab !== "history"}>
                <h2>Optional rank lookup</h2>
                <p className="help">
                    Look up peak rank and MMR on Tracker Network once per player when they join.
                </p>
                <Field label="Enable Tracker Network lookups" htmlFor="rank-lookup-enabled">
                    <input
                        id="rank-lookup-enabled"
                        type="checkbox"
                        checked={settings.enableRankLookup}
                        onChange={(event) => setSettings((current) => ({
                            ...current, enableRankLookup: event.target.checked
                        }))}
                    />
                </Field>
            </section>

            <section className="settings-section" hidden={activeTab !== "app"}>
                <h2>Updates</h2>
                <p className="help">Installed version: {appInfo.version || "Unknown"}</p>
                <p className={`help${updateStatus.state === "error" ? " settings-message error" : ""}`}
                    role="status" aria-live="polite">
                    {updateMessage}
                </p>
                <div className="settings-actions">
                    <button
                        type="button"
                        disabled={!appInfo.isPackaged || updateBusy || updateStatus.state === "downloaded"}
                        onClick={checkForUpdates}
                    >
                        {updateBusy ? "Please wait..." : "Check for updates"}
                    </button>
                    {updateStatus.state === "downloaded" && (
                        <button type="button" onClick={installUpdate}>
                            Restart and install
                        </button>
                    )}
                </div>
            </section>
            <section className="settings-section" hidden={activeTab !== "app"}>
                <h2>Close RLOverlay</h2>
                <p className="help">Close the application and its overlay windows.</p>
                <button type="button" className="close-app-button" disabled={closing} onClick={closeApp}>
                    {closing ? "Closing..." : "Close app"}
                </button>
            </section>
            <div className="settings-footer" hidden={activeTab === "imposter"}>
                <span className="file-path">{filePath}</span>
                <div className="settings-actions">
                    <button type="button" disabled={saving} onClick={() => save()}>
                        Save changes
                    </button>
                </div>
            </div>
            <div
                className={`settings-message${isError ? " error" : ""}`}
                role="status"
                aria-live="polite"
                hidden={activeTab === "imposter"}
            >
                {message}
            </div>
            <div
                className="settings-party-surface party-page"
                hidden={activeTab !== "imposter"}
            >
                <SupabasePartyApp initialName={trackedPlayerName} />
            </div>
        </main>
    );
}
