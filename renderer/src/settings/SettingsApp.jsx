import React, { useEffect, useState } from "react";

const statOptions = [
    ["score", "Score"], ["goals", "Goals"], ["assists", "Assists"],
    ["saves", "Saves"], ["shots", "Shots"], ["demos", "Demos"],
    ["touches", "Ball touches"], ["carTouches", "Car touches"],
    ["postHits", "Post hits"], ["boostCollected", "Boost collected"],
    ["aerialHits", "Aerial hits"], ["kickoffWins", "Kickoff wins"],
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
    const [playerOptions, setPlayerOptions] = useState([]);
    const [filePath, setFilePath] = useState("");
    const [historyFilePath, setHistoryFilePath] = useState("");
    const [historyError, setHistoryError] = useState("");
    const [message, setMessage] = useState("");
    const [isError, setIsError] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        const api = window.rocketLeague;
        const unsubscribe = [
            api.onSettingsUpdated(setSettings),
            api.onMatchHistoryUpdated(({ playerOptions: options, error }) => {
                setPlayerOptions(options);
                setHistoryError(error ?? "");
            }),
            api.onGamepadBindingResult((result) => {
                setMessage(result.message);
                setIsError(result.error === true);
            }),
            api.onSettingsFilePath(setFilePath),
            api.onMatchHistoryFilePath(setHistoryFilePath)
        ];
        let mounted = true;
        api.getSettings().then((result) => {
            if (!mounted) return;
            setSettings(result.settings);
            setPlayerOptions(result.playerOptions);
            setFilePath(`Saved to: ${result.filePath}`);
            setHistoryFilePath(`Match history file: ${result.historyFilePath}`);
        }).catch((error) => {
            if (!mounted) return;
            setMessage(`Could not load settings: ${error.message}`);
            setIsError(true);
        });
        return () => {
            mounted = false;
            unsubscribe.forEach((dispose) => dispose?.());
            api.cancelGamepadBinding();
        };
    }, []);

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

    return (
        <main>
            <h1>Overlay Settings</h1>
            <section className="settings-section">
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

            <section className="settings-section">
                <h2>Controller buttons</h2>
                {[
                    ["overlayButton", "Hold to show overlay"],
                    ["toggleConnectionButton", "Toggle API connection"]
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

            <section className="settings-section">
                <h2>Scoreboard stats</h2>
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

            <section className="settings-section">
                <h2>Match history</h2>
                <Field label="Your player" htmlFor="tracked-player">
                    <select
                        id="tracked-player"
                        value={settings.trackedPlayerId ?? ""}
                        onChange={(event) => setSettings((current) => ({
                            ...current,
                            trackedPlayerId: event.target.value || null
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
                    Choose your player to calculate your record, goal differential, and stats against opponents.
                    Player choices appear when the API detects them. Matches are saved locally when the API
                    reports a match end or a new match starts.
                </p>
                <p className="help" role="status" aria-live="polite">
                    {historyError
                        ? `History error: ${historyError}`
                        : `${playerOptions.length} player${playerOptions.length === 1 ? "" : "s"} available for tracking.`}
                </p>
                <p className="help file-path">{historyFilePath}</p>
                <p className="help">
                    Tracker Network 2v2 peak rank and MMR are looked up once per player when they join.
                    Disable the lookup option below to prevent Tracker Network pages from being opened.
                </p>
            </section>

            <section className="settings-section">
                <h2>Appearance</h2>
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
                    label="Vertical offset"
                    name="overlay-position-y"
                    value={settings.positionYOffset}
                    min="-500"
                    max="500"
                    step="10"
                    format={(value) => `${value} px`}
                    onChange={(value) => setSettings((current) => ({ ...current, positionYOffset: value }))}
                />
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
                    Possession percentages are based on recorded ball touches. Three-zone mode splits the field into top, middle, and bottom thirds.
                </p>
                <Field label="Look up peak ranks on Tracker Network" htmlFor="rank-lookup-enabled">
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

            <div className="settings-footer">
                <span className="file-path">{filePath}</span>
                <button type="button" disabled={saving} onClick={() => save()}>
                    Save settings
                </button>
            </div>
            <div className={`settings-message${isError ? " error" : ""}`} role="status" aria-live="polite">
                {message}
            </div>
        </main>
    );
}
