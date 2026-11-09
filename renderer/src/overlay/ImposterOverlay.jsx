import React, { useEffect, useRef, useState } from "react";

export default function ImposterOverlay() {
    const [game, setGame] = useState(null);
    const [selectedSuspects, setSelectedSuspects] = useState([]);
    const [chatOpen, setChatOpen] = useState(false);
    const [chatDraft, setChatDraft] = useState("");
    const shellRef = useRef(null);
    const previousRoundRef = useRef(null);

    useEffect(() => {
        return window.rocketLeague.onImposterOverlayCardUpdated((nextGame) => {
            setGame(nextGame);
            const roundKey = nextGame ? `${nextGame.roundNumber}:${nextGame.phase}` : null;
            if (previousRoundRef.current !== roundKey) {
                setSelectedSuspects([]);
                if (!nextGame || ["lobby", "results"].includes(nextGame.phase)) {
                    setChatOpen(false);
                }
            }
            if (nextGame?.hasVoted) {
                setSelectedSuspects([]);
            }
            previousRoundRef.current = roundKey;
        });
    }, []);

    useEffect(() => {
        if (!shellRef.current || !game) {
            return undefined;
        }
        const observer = new ResizeObserver(() => {
            window.rocketLeague.resizeImposterOverlay(
                Math.ceil(shellRef.current.getBoundingClientRect().height + 16)
            );
        });
        observer.observe(shellRef.current);
        return () => observer.disconnect();
    }, [game, chatOpen]);

    if (!game) {
        return null;
    }

    function sendAction(action) {
        window.rocketLeague.sendImposterOverlayAction(action);
    }

    function toggleSuspect(id) {
        setSelectedSuspects((selected) => selected.includes(id)
            ? selected.filter((item) => item !== id)
            : [...selected, id]);
    }

    function sendChat(event) {
        event.preventDefault();
        const content = chatDraft.trim();
        if (!content) {
            return;
        }
        sendAction({ type: "send-chat", content });
        setChatDraft("");
    }

    const validVote = game.imposterCount === 1
        ? selectedSuspects.length === 1
        : selectedSuspects.length > 0;
    const chatAvailable = game.chatEnabled &&
        ["playing", "voting"].includes(game.phase);

    return (
        <main className="imposter-overlay-shell" ref={shellRef}>
            <header className="imposter-overlay-header">
                <span>ROUND {game.roundNumber} · {game.phase.toUpperCase()}</span>
                <div>
                    {chatAvailable && (
                        <button
                            className="imposter-overlay-small-button"
                            type="button"
                            onClick={() => setChatOpen((open) => !open)}
                            aria-expanded={chatOpen}
                        >
                            {chatOpen ? "Hide chat" : "Chat"}
                        </button>
                    )}
                    <button
                        className="imposter-overlay-small-button"
                        type="button"
                        onClick={() => sendAction({ type: "leave" })}
                    >
                        Leave
                    </button>
                </div>
            </header>

            {game.card && (
                <section className={`imposter-overlay-card ${game.card.isSafe ? "is-safe" : "is-imposter"}`}>
                    <span className="imposter-overlay-role">{game.card.label}</span>
                    <p>{game.card.task}</p>
                    {game.phase === "playing" && game.isHost && (
                        <button
                            className="imposter-overlay-small-button"
                            type="button"
                            onClick={() => sendAction({ type: "start-voting" })}
                        >
                            Start voting
                        </button>
                    )}
                </section>
            )}

            {game.phase === "voting" && (
                <section className="imposter-overlay-panel">
                    <strong>Who is the imposter?</strong>
                    <div className="imposter-overlay-votes">
                        {game.players.filter((player) => player.id !== game.selfId).map((player) => (
                            <label
                                className={selectedSuspects.includes(player.id) ? "is-selected" : ""}
                                key={player.id}
                            >
                                <input
                                    type="checkbox"
                                    checked={selectedSuspects.includes(player.id)}
                                    disabled={game.hasVoted}
                                    onChange={() => toggleSuspect(player.id)}
                                />
                                <span>{player.name}</span>
                            </label>
                        ))}
                    </div>
                    <div className="imposter-overlay-actions">
                        <button
                            type="button"
                            disabled={game.hasVoted || !validVote}
                            onClick={() => sendAction({
                                type: "vote",
                                suspects: selectedSuspects
                            })}
                        >
                            {game.hasVoted ? "Vote submitted" : "Submit vote"}
                        </button>
                        {game.isHost && (
                            <button
                                className="secondary"
                                type="button"
                                onClick={() => sendAction({ type: "end-voting" })}
                            >
                                End voting
                            </button>
                        )}
                    </div>
                    <small>{game.voteCount}/{game.players.length} players voted</small>
                </section>
            )}

            {game.phase === "results" && game.results && (
                <section className="imposter-overlay-panel">
                    <strong>Round results</strong>
                    <div className="imposter-overlay-results">
                        {game.players.map((player) => (
                            <div key={player.id}>
                                <span>{player.name}</span>
                                <strong className={`imposter-overlay-role-label ${
                                    String(game.results.roles[player.id]).toLowerCase() === "imposter"
                                        ? "is-imposter"
                                        : "is-safe"
                                }`}>
                                    {game.results.roles[player.id]}
                                </strong>
                                <small>{game.results.tally[player.id] ?? 0} votes</small>
                            </div>
                        ))}
                    </div>
                    <button
                        type="button"
                        disabled={game.readyForNextRound}
                        onClick={() => sendAction({ type: "ready-next-round" })}
                    >
                        {game.readyForNextRound
                            ? "Ready · Waiting for next round"
                            : "Ready for next round"}
                    </button>
                    <small>
                        {game.isHost
                            ? "As host, readying starts the next lobby."
                            : "You’ll be readied automatically when the host starts the next lobby."}
                    </small>
                </section>
            )}

            {game.phase === "lobby" && (
                <section className="imposter-overlay-panel">
                    <strong>Players ready</strong>
                    <div className="imposter-overlay-results">
                        {game.players.map((player) => (
                            <div key={player.id}>
                                <span>{player.name}{player.id === game.selfId ? " · You" : ""}</span>
                                <strong className={`imposter-overlay-ready-label ${
                                    player.ready ? "is-ready" : "is-waiting"
                                }`}>
                                    {player.ready ? "Ready" : "Waiting"}
                                </strong>
                            </div>
                        ))}
                    </div>
                    <button
                        type="button"
                        disabled={game.players.find((player) => player.id === game.selfId)?.ready}
                        onClick={() => sendAction({ type: "ready" })}
                    >
                        {game.players.find((player) => player.id === game.selfId)?.ready
                            ? "You’re ready"
                            : "Ready up"}
                    </button>
                </section>
            )}

            {game.message && (
                <p className="imposter-overlay-message" role="status">{game.message}</p>
            )}

            {chatOpen && chatAvailable && (
                <section className="imposter-overlay-panel imposter-overlay-chat">
                    <strong>Round chat · anonymous</strong>
                    <div className="imposter-overlay-messages">
                        {game.messages.map((item) => (
                            <p key={item.id}>
                                <b className={`imposter-overlay-chat-role ${
                                    String(item.roleLabel).toLowerCase() === "imposter"
                                        ? "is-imposter"
                                        : "is-safe"
                                }`}>
                                    {item.roleLabel}:
                                </b> {item.content}
                            </p>
                        ))}
                    </div>
                    <form onSubmit={sendChat}>
                        <input
                            value={chatDraft}
                            onChange={(event) => setChatDraft(event.target.value)}
                            placeholder="Write a message"
                            maxLength={500}
                            aria-label="Anonymous chat message"
                        />
                        <button type="submit" disabled={!chatDraft.trim()}>Send</button>
                    </form>
                </section>
            )}
        </main>
    );
}
