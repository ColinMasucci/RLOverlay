import React, { useEffect, useMemo, useState } from "react";
import challengeOptions from "../../../shared/imposter-challenges.json";
import { supabase } from "./supabase.js";

const SESSION_KEY = "rloverlay-imposter-supabase-session";
const emptySettings = {
    imposterCount: 1,
    challengeAssignment: "random",
    enabledChallenges: challengeOptions.map(({ id }) => id),
    gameMode: "challenge",
    speedUnit: "kph",
    minSpeed: 0,
    maxSpeed: 130,
    imposterHint: true,
    hideImposterRole: false,
    chatEnabled: true
};

function savedSession() {
    try {
        const value = localStorage.getItem(SESSION_KEY);
        return value ? JSON.parse(value) : null;
    } catch (error) {
        console.error("Could not read the saved Imposter session.", error);
        return null;
    }
}

function getLobbyErrorMessage(error, action = "request") {
    const message = [
        error?.message,
        error?.details,
        error?.hint
    ].filter(Boolean).join(" ").toLowerCase();
    const code = String(error?.code ?? "");
    if (message.includes("invalid path specified in request url")) {
        return "The Supabase project URL looks incorrect. Use the project URL only, without /rest/v1 or another path.";
    }
    if (code === "PGRST202" || message.includes("could not find the function")) {
        return "The Imposter database setup is missing or out of date. Run the SQL files in the supabase folder in your Supabase project's SQL Editor, then try again.";
    }
    if (message.includes("lobby code was not found")) {
        return "We couldn't find an open lobby with that code. Check the six-character code with the host and try again.";
    }
    if (message.includes("not enough players") ||
        message.includes("at least two players") ||
        message.includes("minimum of two players")) {
        return "At least two players need to be in the lobby and ready before the round can start. Your lobby is still open while friends join.";
    }
    if (message.includes("round has already started")) {
        return "That game has already started, so new players can't join this lobby.";
    }
    if (message.includes("lobby is full")) {
        return "That lobby is full. Ask the host to start another game.";
    }
    if (message.includes("session has expired")) {
        return "Your saved lobby session has expired. Join a lobby again with a current code.";
    }
    if (message.includes("enter a name")) {
        return "Enter a player name between 1 and 24 characters.";
    }
    if (message.includes("minimum speed") || message.includes("speed range")) {
        return "Choose a maximum speed greater than the minimum speed.";
    }
    if (code === "42P01" || message.includes("does not exist") ||
        message.includes("schema cache") || message.includes("could not find the function")) {
        return "The game database setup is missing or out of date. Run the Supabase SQL setup files from the project's supabase folder, then try again.";
    }
    if (code === "42501" || message.includes("permission denied")) {
        return "Supabase blocked this game action. Run the latest SQL migration from the supabase/migrations folder in your Supabase SQL Editor, then try again.";
    }
    if (message.includes("failed to fetch") || message.includes("networkerror") ||
        message.includes("load failed")) {
        return "We couldn't reach Supabase. Check your internet connection and confirm the local Supabase URL and publishable key.";
    }
    if (action === "host") {
        console.error("Could not create an Imposter lobby.", error);
        return "We couldn't create the lobby. This is not because you're the only player—hosting alone is supported. Supabase couldn't finish the request; check the SQL setup and try again.";
    }
    console.error("Imposter lobby request failed.", error);
    return "We couldn't complete that lobby request. Check your internet connection and Supabase setup, then try again.";
}

function ToggleSetting({ checked, onChange, children, disabled }) {
    return (
        <label className="party-toggle">
            <input
                type="checkbox"
                checked={checked}
                onChange={(event) => onChange(event.target.checked)}
                disabled={disabled}
            />
            <span className="party-toggle-track" aria-hidden="true" />
            <span>{children}</span>
        </label>
    );
}

function PlayerList({ players, selfId }) {
    return (
        <ul className="party-player-list">
            {players.map((player) => (
                <li key={player.id}>
                    <span>{player.name}{player.isHost ? " · Host" : ""}</span>
                    <span className={`party-ready-state ${player.ready ? "is-ready" : "is-waiting"}`}>
                        {player.id === selfId ? "You · " : ""}
                        {player.ready ? "Ready" : "Not ready"}
                    </span>
                </li>
            ))}
        </ul>
    );
}

function RoleCard({ role, settings, challengeLabel, speedTarget, speedHint, roleHidden }) {
    const appearsSafe = role !== "imposter" || roleHidden;
    let task;
    if (settings.gameMode === "speed") {
        if (role === "imposter" && !roleHidden) {
            task = "Blend in and work out the safe players’ target speed.";
            if (speedHint) {
                task += ` Hint: the shared target is between ${speedHint.min} and ${speedHint.max} ${settings.speedUnit.toUpperCase()}.`;
            }
        } else {
            task = `Try to score a goal at ${speedTarget} ${settings.speedUnit.toUpperCase()}. Let your team know how it went.`;
            if (role === "imposter" && speedHint) {
                task += ` Hint: the shared target is between ${speedHint.min} and ${speedHint.max} ${settings.speedUnit.toUpperCase()}.`;
            }
        }
    } else if (role === "imposter") {
        task = `Your task: ${challengeLabel}.`;
    } else {
        task = "There is an imposter among you. Guess who they are and their task.";
    }

    return (
        <div className={`party-role-card ${appearsSafe ? "is-safe" : "is-imposter"}`}>
            <div className="party-role-inset">
                <span className="party-role-label">{appearsSafe ? "SAFE" : "IMPOSTER"}</span>
                <p>{task}</p>
            </div>
        </div>
    );
}

function PartyApp() {
    const [session, setSession] = useState(null);
    const [name, setName] = useState("");
    const [code, setCode] = useState("");
    const [room, setRoom] = useState(null);
    const [role, setRole] = useState(null);
    const [challenge, setChallenge] = useState(null);
    const [speedTarget, setSpeedTarget] = useState(null);
    const [speedHint, setSpeedHint] = useState(null);
    const [roleHidden, setRoleHidden] = useState(false);
    const [results, setResults] = useState(null);
    const [selectedSuspects, setSelectedSuspects] = useState([]);
    const [settings, setSettings] = useState(emptySettings);
    const [chatDraft, setChatDraft] = useState("");
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);

    const self = room?.players.find((player) => player.id === session?.playerId);
    const challengeLabel = useMemo(() =>
        challengeOptions.find((option) => option.id === challenge)?.label ?? challenge,
    [challenge]);
    const messages = room?.messages ?? [];

    function applyState(value) {
        setRoom(value.room);
        setRole(value.role);
        setChallenge(value.challenge);
        setSpeedTarget(value.speedTarget);
        setSpeedHint(value.speedHint);
        setRoleHidden(value.roleHidden === true);
        setResults(value.results);
        setSettings(value.room.settings);
        setCode(value.room.code);
    }

    async function refresh(token = session?.token) {
        if (!supabase || !token) {
            return;
        }
        const { data, error } = await supabase.rpc("imposter_room_state", {
            p_token: token
        });
        if (error) {
            throw error;
        }
        applyState(data);
    }

    useEffect(() => {
        if (!supabase) {
            return undefined;
        }
        let active = true;
        const saved = savedSession();
        if (saved?.token) {
            supabase.rpc("imposter_resume", { p_token: saved.token }).then(({ data, error }) => {
                if (!active) {
                    return;
                }
                if (error) {
                    localStorage.removeItem(SESSION_KEY);
                    setMessage(getLobbyErrorMessage(error));
                    return;
                }
                setSession(saved);
                applyState(data);
                setName(data.room.players.find((player) =>
                    player.id === saved.playerId
                )?.name ?? "");
            }).catch((error) => {
                if (active) {
                    setMessage(getLobbyErrorMessage(error));
                }
            });
        }
        return () => {
            active = false;
        };
    }, []);

    useEffect(() => {
        if (!supabase || !room?.id || !session?.token) {
            return undefined;
        }
        let active = true;
        const channel = supabase
            .channel(`imposter:${room.id}`)
            .on("broadcast", { event: "*" }, () => {
                refresh().catch((error) => {
                    if (active) {
                        setMessage(getLobbyErrorMessage(error));
                    }
                });
            })
            .subscribe((status) => {
                if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                    setMessage("Live lobby updates disconnected. Check your connection.");
                } else if (status === "SUBSCRIBED") {
                    setMessage("");
                }
            });
        const heartbeat = window.setInterval(() => {
            refresh().catch((error) => {
                if (active) {
                    setMessage(getLobbyErrorMessage(error));
                }
            });
        }, 20000);
        return () => {
            active = false;
            window.clearInterval(heartbeat);
            supabase.removeChannel(channel);
        };
    }, [room?.id, session?.token]);

    async function callRpc(method, parameters, { keepSession = true, action } = {}) {
        if (!supabase) {
            setMessage("Add your Supabase URL and publishable key to configure the website.");
            return null;
        }
        setBusy(true);
        setMessage("");
        try {
            const { data, error } = await supabase.rpc(method, parameters);
            if (error) {
                throw error;
            }
            if (data?.room) {
                if (data.token) {
                    const nextSession = { token: data.token, playerId: data.playerId };
                    localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
                    setSession(nextSession);
                } else if (data.playerId && session) {
                    const nextSession = { ...session, playerId: data.playerId };
                    localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
                    setSession(nextSession);
                }
                applyState(data);
            } else if (data?.left && !keepSession) {
                localStorage.removeItem(SESSION_KEY);
                setSession(null);
                setRoom(null);
                setRole(null);
                setChallenge(null);
                setSpeedTarget(null);
                setSpeedHint(null);
                setResults(null);
            }
            return data;
        } catch (error) {
            setMessage(getLobbyErrorMessage(error, action));
            return null;
        } finally {
            setBusy(false);
        }
    }

    async function createLobby() {
        if (!name.trim()) {
            setMessage("Enter your player name before hosting a game.");
            return;
        }
        const response = await callRpc(
            "imposter_create_room",
            { p_name: name },
            { action: "host" }
        );
        if (response?.room) {
            setSelectedSuspects([]);
        }
    }

    async function joinLobby() {
        if (!name.trim()) {
            setMessage("Enter your player name before joining a game.");
            return;
        }
        const lobbyCode = code.trim().toUpperCase();
        if (!lobbyCode) {
            setMessage("Enter the six-character lobby code shared by the host.");
            return;
        }
        if (lobbyCode.length !== 6) {
            setMessage("Lobby codes are six characters. Check the code shared by the host.");
            return;
        }
        const response = await callRpc("imposter_join_room", {
            p_code: lobbyCode,
            p_name: name
        });
        if (response?.room) {
            setSelectedSuspects([]);
        }
    }

    async function updateSettings(next) {
        await callRpc("imposter_update_settings", {
            p_token: session.token,
            p_imposter_count: next.imposterCount,
            p_challenge_assignment: next.challengeAssignment,
            p_enabled_challenges: next.enabledChallenges,
            p_game_mode: next.gameMode,
            p_speed_unit: next.speedUnit,
            p_min_speed: Number(next.minSpeed),
            p_max_speed: Number(next.maxSpeed),
            p_imposter_hint: next.hideImposterRole ? false : next.imposterHint,
            p_hide_imposter_role: next.hideImposterRole,
            p_chat_enabled: next.chatEnabled
        });
    }

    async function readyUp() {
        if (!self?.ready) {
            await callRpc("imposter_set_ready", {
                p_token: session.token,
                p_ready: true
            });
        }
    }

    async function leaveLobby() {
        await callRpc("imposter_leave", { p_token: session.token }, { keepSession: false });
    }

    async function copyLobbyCode() {
        try {
            await navigator.clipboard.writeText(room.code);
            setMessage("Lobby code copied. Send it to your friends.");
        } catch (error) {
            console.error("Could not copy lobby code.", error);
            setMessage(`Share this lobby code with your friends: ${room.code}`);
        }
    }

    async function sendChatMessage(event) {
        event.preventDefault();
        const content = chatDraft.trim();
        if (!content || content.length > 500) {
            return;
        }
        const response = await callRpc("imposter_send_message", {
            p_token: session.token,
            p_content: content
        });
        if (response) {
            setChatDraft("");
        }
    }

    async function castVote() {
        const response = await callRpc("imposter_vote", {
            p_token: session.token,
            p_suspects: selectedSuspects
        });
        if (response?.room) {
            setSelectedSuspects([]);
        }
    }

    function toggleSuspect(id) {
        setSelectedSuspects((selected) => selected.includes(id)
            ? selected.filter((item) => item !== id)
            : [...selected, id]);
    }

    const voteIsValid = room?.settings.imposterCount === 1
        ? selectedSuspects.length === 1
        : selectedSuspects.length > 0;

    if (!supabase) {
        return (
            <main className="party-app party-shell">
                <h1>RL Imposter game</h1>
                <p className="party-message">
                    This website is not connected to Supabase yet. Add
                    <code> VITE_SUPABASE_URL </code> and
                    <code> VITE_SUPABASE_PUBLISHABLE_KEY </code> to the local
                    <code> .env.local </code> file, then restart the dev server.
                </p>
            </main>
        );
    }

    if (!room) {
        return (
            <main className="party-app party-shell">
                <header className="party-landing">
                    <div className="party-landing-copy">
                        <span className="party-eyebrow">ROCKET LEAGUE PARTY GAME</span>
                        <h1>RL Imposter game</h1>
                        <p>Play the match. Hide your task. Find the imposter.</p>
                    </div>
                    <img
                        className="party-hero-car"
                        src="/rocket-league-fan-art.png"
                        alt="Rocket League fan art logo"
                    />
                </header>
                <section className="party-entry-card" aria-label="Host or join a game">
                    <label className="party-field">
                        <span>Your player name</span>
                        <input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            maxLength={24}
                            placeholder="Enter your name"
                            autoComplete="nickname"
                        />
                    </label>
                    <div className="party-entry-actions">
                        <button
                            className="party-primary-button"
                            disabled={!name.trim() || busy}
                            onClick={createLobby}
                        >
                            Host a game
                        </button>
                        <div className="party-join-form">
                            <input
                                value={code}
                                onChange={(event) => setCode(event.target.value.toUpperCase())}
                                maxLength={6}
                                placeholder="LOBBY CODE"
                                aria-label="Lobby code"
                                autoComplete="off"
                            />
                            <button
                                className="party-secondary-button"
                                disabled={busy}
                                onClick={joinLobby}
                            >
                                Join game
                            </button>
                        </div>
                    </div>
                    <p className="party-entry-hint">
                        Hosting creates a lobby and a six-character code to share with friends.
                    </p>
                    {message && <p className="party-message" role="status">{message}</p>}
                </section>
                <footer className="party-landing-footer">BOOST UP · STAY SUS</footer>
            </main>
        );
    }

    return (
        <main className="party-app party-shell party-room-shell">
            <header className="party-header">
                <div>
                    <span className="party-eyebrow">RL IMPOSTER GAME</span>
                    <h1>
                        Lobby
                        <span className="party-code-group">
                            <span className="party-code">{room.code}</span>
                            <button
                                className="party-copy-icon"
                                type="button"
                                onClick={copyLobbyCode}
                                aria-label="Copy lobby code"
                                title="Copy lobby code"
                            >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <rect x="8" y="8" width="12" height="13" rx="2" />
                                    <path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2" />
                                </svg>
                            </button>
                        </span>
                    </h1>
                    {self?.isHost && <div className="party-host-label">You’re the host</div>}
                </div>
                <button className="party-secondary-button" type="button" disabled={busy} onClick={leaveLobby}>
                    Leave game
                </button>
            </header>

            {room.phase === "lobby" && (
                <div className="party-lobby-grid">
                    <section className="party-panel party-players-panel">
                        <div className="party-panel-heading">
                            <div>
                                <span className="party-eyebrow">THE SQUAD</span>
                                <h2>Players <span>{room.players.length}/12</span></h2>
                            </div>
                            <p>
                                {room.players.length < 2
                                    ? "You’re the first player. Share the code so friends can join."
                                    : "Everyone must be ready to start"}
                            </p>
                        </div>
                        <PlayerList players={room.players} selfId={session.playerId} />
                        <button
                            type="button"
                            className={`party-ready-button ${self?.ready ? "is-ready" : "is-waiting"}`}
                            disabled={busy || self?.ready}
                            onClick={readyUp}
                        >
                            {self?.ready ? "YOU’RE READY" : "READY UP"}
                        </button>
                        {self?.ready &&
                            <p className="party-ready-note">You’re locked in. The round starts when everyone is ready.</p>}
                        {room.players.length < 2 &&
                            <p className="party-ready-note">At least two players are needed to start a round. Your lobby is ready and waiting.</p>}
                    </section>

                    {self?.isHost && (
                        <section className="party-panel party-host-settings">
                            <div className="party-panel-heading">
                                <div>
                                    <span className="party-eyebrow">HOST CONTROLS</span>
                                    <h2>Game settings</h2>
                                </div>
                                {room.settingsLocked && <span className="party-locked-badge">LOCKED</span>}
                            </div>
                            {!room.settingsLocked ? (
                                <>
                                    <div className="party-settings-grid">
                                        <label className="party-field">
                                            <span>Game mode</span>
                                            <select
                                                value={settings.gameMode}
                                                onChange={(event) => updateSettings({
                                                    ...settings,
                                                    gameMode: event.target.value
                                                })}
                                                disabled={busy}
                                            >
                                                <option value="challenge">Imposter challenge</option>
                                                <option value="speed">Speed target</option>
                                            </select>
                                        </label>
                                        <label className="party-field">
                                            <span>Number of imposters</span>
                                            <select
                                                value={settings.imposterCount}
                                                onChange={(event) => updateSettings({
                                                    ...settings,
                                                    imposterCount: Number(event.target.value)
                                                })}
                                                disabled={busy}
                                            >
                                                {Array.from({ length: room.players.length }, (_, index) => index + 1)
                                                    .map((count) => <option value={count} key={count}>{count}</option>)}
                                            </select>
                                        </label>
                                        {settings.gameMode === "challenge" && (
                                            <label className="party-field">
                                                <span>Challenge assignment</span>
                                                <select
                                                    value={settings.challengeAssignment}
                                                    onChange={(event) => updateSettings({
                                                        ...settings,
                                                        challengeAssignment: event.target.value
                                                    })}
                                                    disabled={busy}
                                                >
                                                    <option value="random">Random challenge per imposter</option>
                                                    <option value="same">Same challenge for all imposters</option>
                                                </select>
                                            </label>
                                        )}
                                    </div>

                                    {settings.gameMode === "challenge" ? (
                                        <fieldset className="party-challenge-options">
                                            <legend>Challenges in this round</legend>
                                            <div className="party-challenge-grid">
                                                {challengeOptions.map((option) => (
                                                    <label className="party-check" key={option.id}>
                                                        <input
                                                            type="checkbox"
                                                            checked={settings.enabledChallenges.includes(option.id)}
                                                            disabled={busy}
                                                            onChange={(event) => updateSettings({
                                                                ...settings,
                                                                enabledChallenges: event.target.checked
                                                                    ? [...settings.enabledChallenges, option.id]
                                                                    : settings.enabledChallenges.filter((id) => id !== option.id)
                                                            })}
                                                        />
                                                        {option.label}
                                                    </label>
                                                ))}
                                            </div>
                                        </fieldset>
                                    ) : (
                                        <>
                                            <p className="party-settings-note">
                                                Safe players get the same speed. The imposter gets a different one when their role is hidden.
                                            </p>
                                            <div className="party-settings-grid party-speed-fields">
                                                <label className="party-field">
                                                    <span>Minimum speed</span>
                                                    <input
                                                        type="number"
                                                        min="0"
                                                        max="500"
                                                        value={settings.minSpeed}
                                                        disabled={busy}
                                                        onChange={(event) => updateSettings({
                                                            ...settings,
                                                            minSpeed: event.target.value
                                                        })}
                                                    />
                                                </label>
                                                <label className="party-field">
                                                    <span>Maximum speed</span>
                                                    <input
                                                        type="number"
                                                        min="1"
                                                        max="500"
                                                        value={settings.maxSpeed}
                                                        disabled={busy}
                                                        onChange={(event) => updateSettings({
                                                            ...settings,
                                                            maxSpeed: event.target.value
                                                        })}
                                                    />
                                                </label>
                                                <label className="party-field">
                                                    <span>Speed units</span>
                                                    <select
                                                        value={settings.speedUnit}
                                                        disabled={busy}
                                                        onChange={(event) => updateSettings({
                                                            ...settings,
                                                            speedUnit: event.target.value
                                                        })}
                                                    >
                                                        <option value="kph">Kilometers per hour (kph)</option>
                                                        <option value="mph">Miles per hour (mph)</option>
                                                    </select>
                                                </label>
                                            </div>
                                            <div className="party-toggle-grid">
                                                <ToggleSetting
                                                    checked={settings.imposterHint}
                                                    disabled={busy || settings.hideImposterRole}
                                                    onChange={(checked) => updateSettings({
                                                        ...settings,
                                                        imposterHint: checked
                                                    })}
                                                >
                                                    Give the imposter a broad hint
                                                </ToggleSetting>
                                                <ToggleSetting
                                                    checked={settings.hideImposterRole}
                                                    disabled={busy}
                                                    onChange={(checked) => updateSettings({
                                                        ...settings,
                                                        hideImposterRole: checked
                                                    })}
                                                >
                                                    Hide the imposter role
                                                </ToggleSetting>
                                            </div>
                                            {settings.hideImposterRole && (
                                                <p className="party-settings-note">
                                                    The hint is disabled while roles are hidden, so it won’t give away the imposter.
                                                </p>
                                            )}
                                        </>
                                    )}
                                    <ToggleSetting
                                        checked={settings.chatEnabled}
                                        disabled={busy}
                                        onChange={(checked) => updateSettings({
                                            ...settings,
                                            chatEnabled: checked
                                        })}
                                    >
                                        Enable anonymous round chat
                                    </ToggleSetting>
                                </>
                            ) : (
                                <p className="party-locked-note">
                                    Settings are locked after the first round starts.
                                    {settings.chatEnabled ? " Anonymous chat is enabled." : " Anonymous chat is disabled."}
                                </p>
                            )}
                        </section>
                    )}
                </div>
            )}

            {room.phase === "playing" && (
                <section className="party-round">
                    <RoleCard
                        role={role}
                        settings={room.settings}
                        challengeLabel={challengeLabel}
                        speedTarget={speedTarget}
                        speedHint={speedHint}
                        roleHidden={roleHidden}
                    />
                    {self?.isHost && (
                        <button
                            className="party-primary-button party-start-voting"
                            type="button"
                            disabled={busy}
                            onClick={() => callRpc("imposter_match_ended", {
                                p_token: session.token
                            })}
                        >
                            End match · Start voting
                        </button>
                    )}
                </section>
            )}

            {room.phase === "voting" && (
                <section className="party-panel party-voting">
                    <span className="party-eyebrow">ROUND VOTE</span>
                    <h2>Who is the imposter?</h2>
                    <p>
                        {room.settings.imposterCount === 1
                            ? "Choose exactly one player."
                            : "Choose one or more players. You cannot vote for yourself."}
                    </p>
                    <div className="party-vote-list">
                        {room.players.filter((player) => player.id !== session.playerId).map((player) => (
                            <label className="party-check" key={player.id}>
                                <input
                                    type="checkbox"
                                    checked={selectedSuspects.includes(player.id)}
                                    disabled={self?.voted || busy}
                                    onChange={() => toggleSuspect(player.id)}
                                />
                                {player.name}
                            </label>
                        ))}
                    </div>
                    <button
                        className="party-primary-button"
                        type="button"
                        disabled={self?.voted || !voteIsValid || busy}
                        onClick={castVote}
                    >
                        {self?.voted ? "Vote submitted" : "Submit secret vote"}
                    </button>
                    {self?.isHost && (
                        <button
                            className="party-secondary-button"
                            type="button"
                            disabled={busy}
                            onClick={() => callRpc("imposter_end_voting", {
                                p_token: session.token
                            })}
                        >
                            End voting
                        </button>
                    )}
                    <p>{room.players.filter((player) => player.voted).length} of {room.players.length} voted</p>
                </section>
            )}

            {room.phase === "results" && results && (
                <section className="party-panel party-results">
                    <span className="party-eyebrow">ROUND COMPLETE</span>
                    <h2>Results</h2>
                    {room.players.map((player) => (
                        <div className="party-result-player" key={player.id}>
                            <span>{player.name} <strong>{results.roles[player.id]}</strong></span>
                            <span>
                                {results.tally[player.id] ?? 0} vote(s)
                                {results.speedTargets?.[player.id] != null &&
                                    ` · ${results.speedTargets[player.id]} ${room.settings.speedUnit.toUpperCase()}`}
                            </span>
                        </div>
                    ))}
                    {self?.isHost && (
                        <button
                            className="party-primary-button"
                            type="button"
                            disabled={busy}
                            onClick={() => callRpc("imposter_next_round", {
                                p_token: session.token
                            })}
                        >
                            Start next round
                        </button>
                    )}
                </section>
            )}

            {room.settings.chatEnabled && ["playing", "voting"].includes(room.phase) && (
                <section className="party-panel party-chat">
                    <div className="party-panel-heading">
                        <div>
                            <span className="party-eyebrow">SAY IT ANONYMOUSLY</span>
                            <h2>Round chat</h2>
                        </div>
                        <span className="party-chat-privacy">No names shown</span>
                    </div>
                    <div className="party-chat-messages" aria-live="polite">
                        {messages.length ? messages.map((item) => (
                            <article className="party-chat-message" key={item.id}>
                                <span className={`party-chat-role ${item.roleLabel === "Imposter" ? "is-imposter" : ""}`}>
                                    {item.roleLabel}
                                </span>
                                <p>{item.content}</p>
                            </article>
                        )) : <p className="party-chat-empty">No messages yet. Start the conversation.</p>}
                    </div>
                    <form className="party-chat-form" onSubmit={sendChatMessage}>
                        <input
                            value={chatDraft}
                            onChange={(event) => setChatDraft(event.target.value)}
                            maxLength={500}
                            placeholder="Send an anonymous message…"
                            aria-label="Anonymous chat message"
                            disabled={busy}
                        />
                        <button
                            className="party-primary-button"
                            type="submit"
                            disabled={busy || !chatDraft.trim()}
                        >
                            Send
                        </button>
                    </form>
                </section>
            )}
            {message && <p className="party-message" role="status">{message}</p>}
        </main>
    );
}

export default PartyApp;
