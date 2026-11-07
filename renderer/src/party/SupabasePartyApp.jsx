import React, { useEffect, useMemo, useState } from "react";
import challengeOptions from "../../../shared/imposter-challenges.json";
import { supabase } from "./supabase.js";

const SESSION_KEY = "rloverlay-imposter-supabase-session";
const emptySettings = {
    imposterCount: 1,
    challengeAssignment: "random",
    enabledChallenges: challengeOptions.map(({ id }) => id)
};

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

function savedSession() {
    try {
        const value = localStorage.getItem(SESSION_KEY);
        return value ? JSON.parse(value) : null;
    } catch (error) {
        console.error("Could not read the saved Imposter session.", error);
        return null;
    }
}

function getLobbyErrorMessage(error) {
    const message = String(error?.message ?? "").toLowerCase();
    const code = String(error?.code ?? "");

    if (message.includes("invalid path specified in request url")) {
        return "The Supabase project URL looks incorrect. Use the project URL only, without /rest/v1 or another path.";
    }
    if (code === "PGRST202" || message.includes("could not find the function")) {
        return "The Imposter database setup is missing. Run supabase/schema.sql in your Supabase project's SQL Editor, then try again.";
    }
    if (message.includes("lobby code was not found") || message.includes("lobby code was not found or has expired")) {
        return "We couldn't find an open lobby with that code. Check the six-character code with the host and try again.";
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

    console.error("Imposter lobby request failed.", error);
    return "We couldn't complete that lobby request. Check your internet connection and Supabase setup, then try again.";
}

function PartyApp() {
    const [session, setSession] = useState(null);
    const [name, setName] = useState("");
    const [code, setCode] = useState("");
    const [room, setRoom] = useState(null);
    const [role, setRole] = useState(null);
    const [challenge, setChallenge] = useState(null);
    const [results, setResults] = useState(null);
    const [selectedSuspects, setSelectedSuspects] = useState([]);
    const [settings, setSettings] = useState(emptySettings);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);

    const self = room?.players.find((player) => player.id === session?.playerId);
    const challengeLabel = useMemo(() =>
        challengeOptions.find((option) => option.id === challenge)?.label ?? challenge,
    [challenge]);

    function applyState(value) {
        setRoom(value.room);
        setRole(value.role);
        setChallenge(value.challenge);
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
                    setMessage(`Could not restore the lobby session: ${error.message}`);
                    return;
                }
                setSession(saved);
                applyState(data);
                setName(data.room.players.find((player) =>
                    player.id === saved.playerId
                )?.name ?? "");
            }).catch((error) => {
                if (active) {
                    setMessage(`Could not restore the lobby session: ${error.message}`);
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
                        setMessage(`Could not refresh the lobby: ${error.message}`);
                    }
                });
            })
            .subscribe((status) => {
                if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                    setMessage(`Lobby updates disconnected (${status}).`);
                } else if (status === "SUBSCRIBED") {
                    setMessage("");
                }
            });
        const heartbeat = window.setInterval(() => {
            refresh().catch((error) => {
                if (active) {
                    setMessage(`Could not refresh the lobby: ${error.message}`);
                }
            });
        }, 20000);

        return () => {
            active = false;
            window.clearInterval(heartbeat);
            supabase.removeChannel(channel);
        };
    }, [room?.id, session?.token]);

    async function callRpc(method, parameters, { keepSession = true } = {}) {
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
                    const nextSession = {
                        token: data.token,
                        playerId: data.playerId
                    };
                    localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
                    setSession(nextSession);
                } else if (data.playerId && session) {
                    const nextSession = { ...session, playerId: data.playerId };
                    localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
                    setSession(nextSession);
                }
                applyState(data);
            } else if (data?.left) {
                if (!keepSession) {
                    localStorage.removeItem(SESSION_KEY);
                    setSession(null);
                    setRoom(null);
                    setRole(null);
                    setChallenge(null);
                    setResults(null);
                }
            }
            return data;
        } catch (error) {
            setMessage(getLobbyErrorMessage(error));
            return null;
        } finally {
            setBusy(false);
        }
    }

    async function createLobby() {
        const response = await callRpc("imposter_create_room", {
            p_name: name
        });
        if (response?.room) {
            setSelectedSuspects([]);
        }
    }

    async function joinLobby() {
        if (!name.trim()) {
            setMessage("Enter your player name before joining a lobby.");
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
            p_enabled_challenges: next.enabledChallenges
        });
    }

    async function leaveLobby() {
        await callRpc("imposter_leave", { p_token: session.token }, { keepSession: false });
    }

    async function toggleReady() {
        await callRpc("imposter_set_ready", {
            p_token: session.token,
            p_ready: !self?.ready
        });
    }

    async function toggleChallengeComplete() {
        await callRpc("imposter_set_challenge_complete", {
            p_token: session.token,
            p_complete: !self?.challengeComplete
        });
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
            <section className="party-app">
                <h2>Imposter lobby</h2>
                <p className="party-message">
                    This website is not connected to Supabase yet. Add
                    <code> VITE_SUPABASE_URL </code> and
                    <code> VITE_SUPABASE_PUBLISHABLE_KEY </code> in your local
                    <code> .env.local </code> file and in Vercel’s project environment variables,
                    then redeploy.
                </p>
            </section>
        );
    }

    if (!room) {
        return (
            <section className="party-app">
                <h2>Imposter lobby</h2>
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
                    <button disabled={!name.trim() || busy} onClick={createLobby}>
                        Host
                    </button>
                    <input
                        value={code}
                        onChange={(event) => setCode(event.target.value.toUpperCase())}
                        maxLength={6}
                        placeholder="Lobby code"
                        aria-label="Lobby code"
                    />
                    <button
                        disabled={busy}
                        onClick={joinLobby}
                    >
                        Join
                    </button>
                </div>
                {message && <p className="party-message" role="status">{message}</p>}
            </section>
        );
    }

    return (
        <section className="party-app">
            <header className="party-header">
                <div>
                    <h2>Imposter</h2>
                    <div className="party-code">Code: {room.code}</div>
                    {self?.isHost && <div className="party-host-label">Host</div>}
                </div>
                <div className="party-actions">
                    <button type="button" disabled={busy} onClick={leaveLobby}>Leave</button>
                </div>
            </header>

            {room.phase === "lobby" && (
                <>
                    <PlayerList players={room.players} selfId={session.playerId} />
                    {self?.isHost && (
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
                                    disabled={busy}
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
                                    disabled={busy}
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
                            </fieldset>
                        </div>
                    )}
                    <button
                        type="button"
                        className="party-ready-button"
                        disabled={busy}
                        onClick={toggleReady}
                    >
                        {self?.ready ? "✓ Ready — click to unready" : "✓ Ready up"}
                    </button>
                    {room.players.length < 2 &&
                        <p className="party-message">Waiting for at least one more player.</p>}
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
                            <p className="party-tracking-note">Web players self-report all challenges.</p>
                            <button
                                type="button"
                                className={self?.challengeComplete ? "is-complete" : ""}
                                disabled={busy}
                                onClick={toggleChallengeComplete}
                            >
                                {self?.challengeComplete ? "✓ Challenge complete" : "Mark challenge complete"}
                            </button>
                        </>
                    )}
                    <p>Round in progress. Voting starts when the Rocket League match ends.</p>
                    {self?.isHost && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => callRpc("imposter_match_ended", {
                                p_token: session.token
                            })}
                        >
                            Match ended · Start voting
                        </button>
                    )}
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
                    <button
                        type="button"
                        disabled={self?.voted || !voteIsValid || busy}
                        onClick={castVote}
                    >
                        {self?.voted ? "Vote submitted" : "Submit secret vote"}
                    </button>
                    {self?.isHost && (
                        <button
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
                    {self?.isHost && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => callRpc("imposter_next_round", {
                                p_token: session.token
                            })}
                        >
                            Start next round
                        </button>
                    )}
                </div>
            )}

            {message && <p className="party-message" role="status">{message}</p>}
        </section>
    );
}

export default PartyApp;
