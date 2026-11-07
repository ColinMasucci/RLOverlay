import React, { useEffect, useMemo, useRef, useState } from "react";
import challengeOptions from "../../../shared/imposter-challenges.json";
import SupabasePartyApp from "./SupabasePartyApp.jsx";

const SESSION_KEY = "rloverlay-imposter-session";
const DEFAULT_SERVER_URL = "ws://localhost:3001";
const emptySettings = {
    imposterCount: 1,
    challengeAssignment: "random",
    enabledChallenges: challengeOptions.map(({ id }) => id)
};

function toWebSocketUrl(value) {
    const url = new URL(value);
    if (url.protocol === "http:") {
        url.protocol = "ws:";
    } else if (url.protocol === "https:") {
        url.protocol = "wss:";
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
        throw new Error("Server URL must use ws:// or wss://.");
    }
    return url.toString();
}

function readSavedSession() {
    try {
        const saved = sessionStorage.getItem(SESSION_KEY);
        return saved ? JSON.parse(saved) : null;
    } catch {
        return null;
    }
}

function PlayerList({ players, selfId }) {
    return (
        <ul className="party-player-list">
            {players.map((player) => (
                <li key={player.id}>
                    <span>{player.name}{player.isHost ? " · Host" : ""}</span>
                    <span>{player.id === selfId
                        ? "You"
                        : player.ready
                            ? "✓ Ready"
                            : "Not ready"}</span>
                </li>
            ))}
        </ul>
    );
}

function LegacyPartyApp() {
    const overlayMode = new URLSearchParams(window.location.search).has("overlay");
    const socketRef = useRef(null);
    const hasJoinedLobbyRef = useRef(false);
    const [serverUrl, setServerUrl] = useState(() =>
        localStorage.getItem("rloverlay-imposter-server") || DEFAULT_SERVER_URL
    );
    const [name, setName] = useState("");
    const [code, setCode] = useState("");
    const [selfId, setSelfId] = useState("");
    const [room, setRoom] = useState(null);
    const [role, setRole] = useState(null);
    const [challenge, setChallenge] = useState(null);
    const [results, setResults] = useState(null);
    const [selectedSuspects, setSelectedSuspects] = useState([]);
    const [settings, setSettings] = useState(emptySettings);
    const [message, setMessage] = useState("");
    const [connected, setConnected] = useState(false);

    const self = room?.players.find((player) => player.id === selfId);
    const isHost = self?.isHost === true;
    const challengeLabel = useMemo(() =>
        challengeOptions.find((option) => option.id === challenge)?.label ?? challenge,
    [challenge]);

    function saveSession(session) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
        if (window.rocketLeague?.saveImposterSession) {
            window.rocketLeague.saveImposterSession(session).catch((error) => {
                setMessage(`Could not save the lobby session: ${error.message}`);
            });
        }
    }

    function connect(urlValue, resumeToken = null) {
        let url;
        try {
            url = toWebSocketUrl(urlValue);
        } catch (error) {
            setMessage(error.message);
            return;
        }
        localStorage.setItem("rloverlay-imposter-server", urlValue);
        const socket = new WebSocket(url);
        socketRef.current = socket;
        socket.addEventListener("open", () => {
            setConnected(true);
            setMessage("");
            if (resumeToken) {
                socket.send(JSON.stringify({ type: "resume", token: resumeToken }));
            }
        });
        socket.addEventListener("message", (event) => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch {
                setMessage("Received an invalid response from the lobby server.");
                return;
            }
            if (data.type === "error") {
                setMessage(data.message);
                if (data.message === "This lobby session has expired.") {
                    hasJoinedLobbyRef.current = false;
                    sessionStorage.removeItem(SESSION_KEY);
                    window.rocketLeague?.saveImposterSession?.(null)?.catch((error) => {
                        setMessage(`Could not clear the lobby session: ${error.message}`);
                    });
                    setRoom(null);
                    setRole(null);
                    setChallenge(null);
                    setResults(null);
                    setSelfId("");
                    socket.close();
                } else if (!hasJoinedLobbyRef.current) {
                    socket.close();
                }
            } else if (data.type === "joined") {
                hasJoinedLobbyRef.current = true;
                setSelfId(data.playerId);
                const session = {
                    serverUrl: urlValue,
                    token: data.token,
                    playerId: data.playerId
                };
                saveSession(session);
                if (!overlayMode && window.rocketLeague?.openImposterWindow) {
                    window.rocketLeague.openImposterWindow(session).catch((error) => {
                        setMessage(`Could not open the game window: ${error.message}`);
                    });
                }
            } else if (data.type === "room") {
                setRoom(data.room);
                setRole(data.role);
                setChallenge(data.challenge);
                setResults(data.results);
                setSettings(data.room.settings);
                setCode(data.room.code);
            }
        });
        socket.addEventListener("close", () => {
            if (socketRef.current === socket) {
                setConnected(false);
                hasJoinedLobbyRef.current = false;
                socketRef.current = null;
            }
        });
        socket.addEventListener("error", () => {
            setMessage("Could not connect to the lobby server. Check the URL and try again.");
        });
    }

    function send(data, reportError = true) {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            if (reportError) {
                setMessage("Not connected to the lobby server.");
            }
            return false;
        }
        socket.send(JSON.stringify(data));
        return true;
    }

    useEffect(() => {
        let mounted = true;
        const saved = readSavedSession();
        const fromElectron = window.rocketLeague?.getImposterSession?.();
        if (!overlayMode && window.rocketLeague?.getSettings) {
            window.rocketLeague.getSettings().then(({ settings: appSettings, playerOptions }) => {
                if (!mounted || !appSettings.trackedPlayerId) {
                    return;
                }
                const trackedPlayer = playerOptions.find((option) =>
                    option.id === appSettings.trackedPlayerId
                );
                if (trackedPlayer) {
                    setName(trackedPlayer.name);
                }
            }).catch((error) => {
                if (mounted) {
                    setMessage(`Could not read the selected in-game name: ${error.message}`);
                }
            });
        }
        Promise.resolve(fromElectron).then((session) => {
            if (!mounted) {
                return;
            }
            const resume = window.rocketLeague?.getImposterSession ? session : saved;
            if (resume?.token && resume.serverUrl) {
                setServerUrl(resume.serverUrl);
                connect(resume.serverUrl, resume.token);
            }
        }).catch((error) => {
            if (mounted) {
                setMessage(`Could not restore the lobby session: ${error.message}`);
            }
        });

        const unsubscribeMatchEnd = window.rocketLeague?.onImposterMatchEnded?.(() => {
            send({ type: "match-ended" });
        });
        const unsubscribeGameStats = window.rocketLeague?.onImposterGameStats?.((stats) => {
            send({ type: "game-stats", ...stats });
        });
        return () => {
            mounted = false;
            unsubscribeMatchEnd?.();
            unsubscribeGameStats?.();
            if (socketRef.current) {
                socketRef.current.close();
            }
        };
    }, []);

    function createLobby() {
        setRoom(null);
        hasJoinedLobbyRef.current = false;
        connect(serverUrl);
        const socket = socketRef.current;
        if (socket) {
            socket.addEventListener("open", () => {
                socket.send(JSON.stringify({ type: "create", name }));
            }, { once: true });
        }
    }

    function joinLobby() {
        setRoom(null);
        hasJoinedLobbyRef.current = false;
        connect(serverUrl);
        const socket = socketRef.current;
        if (socket) {
            socket.addEventListener("open", () => {
                socket.send(JSON.stringify({ type: "join", code, name }));
            }, { once: true });
        }
    }

    function updateSettings(next) {
        setSettings(next);
        send({ type: "settings", ...next });
    }

    function leaveLobby() {
        send({ type: "leave" }, false);
        hasJoinedLobbyRef.current = false;
        sessionStorage.removeItem(SESSION_KEY);
        window.rocketLeague?.saveImposterSession?.(null)?.catch((error) => {
            setMessage(`Could not clear the lobby session: ${error.message}`);
        });
        if (!overlayMode) {
            window.rocketLeague?.closeImposterWindow?.().catch((error) => {
                setMessage(`Could not close the game window: ${error.message}`);
            });
        }
        setRoom(null);
        setRole(null);
        setChallenge(null);
        setResults(null);
        setSelfId("");
    }

    function openOverlay() {
        const session = readSavedSession();
        if (!session?.token || !window.rocketLeague?.openImposterWindow) {
            return;
        }
        window.rocketLeague.openImposterWindow(session).catch((error) => {
            setMessage(`Could not open the game window: ${error.message}`);
        });
    }

    function toggleSuspect(id) {
        setSelectedSuspects((selected) => selected.includes(id)
            ? selected.filter((item) => item !== id)
            : [...selected, id]);
    }

    const voteIsValid = room?.settings.imposterCount === 1
        ? selectedSuspects.length === 1
        : selectedSuspects.length > 0;

    function castVote() {
        if (send({ type: "vote", suspects: selectedSuspects })) {
            setSelectedSuspects([]);
        }
    }

    if (!room) {
        return (
            <section className={`party-app${overlayMode ? " party-overlay-mode" : ""}`}>
                {!overlayMode && <h2>Imposter lobby</h2>}
                <label className="party-field">
                    <span>Lobby server</span>
                    <input
                        value={serverUrl}
                        onChange={(event) => setServerUrl(event.target.value)}
                        placeholder="wss://your-lobby-server.example"
                        disabled={connected}
                    />
                </label>
                <label className="party-field">
                    <span>In-game name</span>
                    <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={24}
                        placeholder="Enter your name"
                    />
                </label>
                <div className="party-actions">
                    <button disabled={!name.trim() || connected} onClick={createLobby}>
                        Host
                    </button>
                    <input
                        value={code}
                        onChange={(event) => setCode(event.target.value.toUpperCase())}
                        maxLength={6}
                        placeholder="Lobby code"
                        aria-label="Lobby code"
                    />
                    <button disabled={!name.trim() || code.length !== 6 || connected} onClick={joinLobby}>
                        Join
                    </button>
                </div>
                {message && <p className="party-message">{message}</p>}
            </section>
        );
    }

    return (
        <section className={`party-app${overlayMode ? " party-overlay-mode" : ""}`}>
            <header className="party-header">
                <div>
                    <h2>Imposter</h2>
                    <div className="party-code">Code: {room.code}</div>
                    {isHost && <div className="party-host-label">Host</div>}
                </div>
                <div className="party-actions">
                    {window.rocketLeague?.openImposterWindow && !overlayMode &&
                        <button type="button" onClick={openOverlay}>Open game window</button>}
                    <button type="button" onClick={leaveLobby}>Leave</button>
                </div>
            </header>

            {room.phase === "lobby" && (
                <>
                    <PlayerList players={room.players} selfId={selfId} />
                    {isHost && (
                        <div className="party-host-settings">
                            <label className="party-field">
                                <span>Imposters: {settings.imposterCount}</span>
                                <input
                                    type="range"
                                    min="1"
                                    max={room.players.length}
                                    value={Math.min(settings.imposterCount, room.players.length)}
                                    onChange={(event) => updateSettings({
                                        ...settings,
                                        imposterCount: Number(event.target.value)
                                    })}
                                />
                            </label>
                            <label className="party-field">
                                <span>Challenges per imposter</span>
                                <select
                                    value={settings.challengeAssignment}
                                    onChange={(event) => updateSettings({
                                        ...settings,
                                        challengeAssignment: event.target.value
                                    })}
                                >
                                    <option value="random">Random individual challenge</option>
                                    <option value="same">Same challenge for everyone</option>
                                </select>
                            </label>
                            <fieldset>
                                <legend>Available challenges</legend>
                                {challengeOptions.map((option) => (
                                    <label className="party-check" key={option.id}>
                                        <input
                                            type="checkbox"
                                            checked={settings.enabledChallenges.includes(option.id)}
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
                            </fieldset>
                        </div>
                    )}
                    <button
                        type="button"
                        className="party-ready-button"
                        onClick={() => send({ type: "ready", ready: !self?.ready })}
                    >
                        {self?.ready ? "✓ Ready — click to unready" : "✓ Ready up"}
                    </button>
                    {room.players.length < 2 && <p className="party-message">Waiting for at least one more player.</p>}
                </>
            )}

            {room.phase === "playing" && (
                <div className="party-round">
                    <div className={`party-role ${role === "imposter" ? "is-imposter" : ""}`}>
                        {role === "imposter" ? "IMPOSTER" : "SAFE"}
                    </div>
                    {role === "imposter" && (
                        <>
                            <p className="party-challenge">{challengeLabel}</p>
                            <p className="party-tracking-note">
                                {challengeOptions.find((option) => option.id === challenge)?.tracking === "automatic"
                                    ? "RLOverlay tracks this on PC when your in-game player is selected; web players self-report."
                                    : "Self-reported challenge."}
                            </p>
                            <button
                                type="button"
                                className={self?.challengeComplete ? "is-complete" : ""}
                                onClick={() => send({
                                    type: "challenge-complete",
                                    complete: !self?.challengeComplete
                                })}
                            >
                                {self?.challengeComplete ? "✓ Challenge complete" : "Mark challenge complete"}
                            </button>
                        </>
                    )}
                    <p>Round in progress. Voting starts when the Rocket League match ends.</p>
                    {isHost && <button type="button" onClick={() => send({ type: "match-ended" })}>Match ended · Start voting</button>}
                </div>
            )}

            {room.phase === "voting" && (
                <div className="party-voting">
                    <h3>Who is the imposter?</h3>
                    <p>
                        {room.settings.imposterCount === 1
                            ? "Choose exactly one player."
                            : "Choose one or more players. You cannot vote for yourself."}
                    </p>
                    {room.players.filter((player) => player.id !== selfId).map((player) => (
                        <label className="party-check" key={player.id}>
                            <input
                                type="checkbox"
                                checked={selectedSuspects.includes(player.id)}
                                disabled={self?.voted}
                                onChange={() => toggleSuspect(player.id)}
                            />
                            {player.name}
                        </label>
                    ))}
                    <button type="button" disabled={self?.voted || !voteIsValid} onClick={castVote}>
                        {self?.voted ? "Vote submitted" : "Submit secret vote"}
                    </button>
                    {isHost && <button type="button" onClick={() => send({ type: "end-voting" })}>End voting</button>}
                    <p>{room.players.filter((player) => player.voted).length} of {room.players.length} voted</p>
                </div>
            )}

            {room.phase === "results" && results && (
                <div className="party-results">
                    <h3>Results</h3>
                    {room.players.map((player) => (
                        <div className="party-result-player" key={player.id}>
                            <span>{player.name} — {results.roles[player.id]}</span>
                            <span>{results.tally[player.id] ?? 0} vote(s)</span>
                        </div>
                    ))}
                    {isHost && <button type="button" onClick={() => send({ type: "next-round" })}>Start next round</button>}
                </div>
            )}

            {message && <p className="party-message">{message}</p>}
        </section>
    );
}

export default function PartyApp() {
    return window.rocketLeague
        ? <LegacyPartyApp />
        : <SupabasePartyApp />;
}
