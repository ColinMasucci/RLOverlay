import React from "react";

function signedNumber(value) {
    return value > 0 ? `+${value}` : String(value);
}

function formatPercentage(value) {
    return Number.isFinite(value) ? `${Math.round(value)}%` : "—";
}

function HistoryCard({ label, value }) {
    return (
        <div className="history-card">
            <div className="history-card-label">{label}</div>
            <div className="history-card-value">{value}</div>
        </div>
    );
}

function GameSequence({ games }) {
    const groups = [];
    for (const game of games.slice(0, 20)) {
        const date = new Date(game.finishedAt);
        const localDate = Number.isFinite(date.getTime())
            ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
            : String(game.finishedAt).slice(0, 10);
        const label = Number.isFinite(date.getTime())
            ? date.toDateString() === new Date().toDateString()
                ? "Today"
                : date.toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric"
                })
            : localDate || "Unknown date";
        let group = groups[groups.length - 1];
        if (!group || group.date !== localDate) {
            group = { date: localDate, label, games: [] };
            groups.push(group);
        }
        group.games.push(game);
    }

    const rows = [
        ...groups.slice(0, 2),
        ...(groups.length > 2
            ? [{
                label: groups.length > 3
                    ? `Earlier · ${groups[groups.length - 1].label} – ${groups[2].label}`
                    : groups[2].label,
                games: groups.slice(2).flatMap((group) => group.games)
            }]
            : [])
    ];

    return (
        <div className="game-sequence">
            {rows.map((group) => (
                <div className="game-sequence-row" key={group.date ?? "earlier"}>
                    <span className="game-day-divider">{group.label}</span>
                    <div className="game-sequence-results">
                        {group.games.map((game) => {
                            const date = new Date(game.finishedAt);
                            const title =
                                `${game.outcome[0].toUpperCase()}${game.outcome.slice(1)} · ` +
                                (Number.isFinite(date.getTime())
                                    ? date.toLocaleString()
                                    : game.finishedAt);
                            return (
                                <span
                                    key={game.id}
                                    className={`game-result ${game.outcome}`}
                                    title={title}
                                    aria-label={title}
                                >
                                    {game.outcome === "win" ? "✓" : game.outcome === "loss" ? "×" : "–"}
                                </span>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}

function OpponentTable({ opponents }) {
    return (
        <section>
            <h2>Head-to-head · last 10 games</h2>
            <table className="head-to-head-table">
                <thead>
                    <tr>
                        <th>Opponent</th>
                        <th>Record</th>
                        <th>Goals For-Against</th>
                        <th>Diff.</th>
                        <th>Kickoff W-L-D</th>
                        <th>Kickoff %</th>
                        <th>Games</th>
                    </tr>
                </thead>
                <tbody>
                    {opponents.length === 0
                        ? <tr><td className="empty" colSpan="7">No opponent records available.</td></tr>
                        : opponents.map((opponent) => (
                            <tr
                                key={opponent.id}
                                className={opponent.isCurrentMatch ? "current-match-opponent" : undefined}
                                title={opponent.isCurrentMatch ? "In your current match" : undefined}
                            >
                                <td>{opponent.name}</td>
                                <td>{`${opponent.wins}-${opponent.losses}-${opponent.draws}`}</td>
                                <td>{`${opponent.goalsFor}-${opponent.goalsAgainst}`}</td>
                                <td>{signedNumber(opponent.goalsFor - opponent.goalsAgainst)}</td>
                                <td>{`${opponent.kickoffWins}-${opponent.kickoffLosses}-${opponent.kickoffDraws}`}</td>
                                <td>{formatPercentage(opponent.kickoffWinPercentage)}</td>
                                <td>{opponent.games}</td>
                            </tr>
                        ))}
                </tbody>
            </table>
        </section>
    );
}

export default function MatchHistory({ history, settingsShortcut }) {
    if (history.error) {
        return <div className="subtitle">Match history error: {history.error}</div>;
    }
    if (!history.trackedPlayerId) {
        const noun = history.totalMatches === 1 ? "match" : "matches";
        return (
            <div className="subtitle">
                {history.totalMatches} completed {noun} saved. Set your player in Settings ({settingsShortcut}) to see personal stats.
            </div>
        );
    }

    const summary = history.summary;
    const display = summary?.display;
    if (!display?.games) {
        return (
            <div className="subtitle">
                No completed matches found for your selected player ({history.totalMatches} total saved).
            </div>
        );
    }

    const stats = display.stats;
    const cards = [
        ["Record", `${display.wins}-${display.losses}-${display.draws}`],
        ["Goal differential", signedNumber(display.goalsFor - display.goalsAgainst)],
        ["Goals for / against", `${display.goalsFor} / ${display.goalsAgainst}`],
        ["Goals per match", (display.goalsFor / display.games).toFixed(1)],
        ["Goals", stats.goals],
        ["Assists", stats.assists],
        ["Saves", stats.saves],
        ["Shots", stats.shots],
        ["Demos", stats.demos],
        ["Ball touches", stats.touches],
        ["Aerial hits", stats.aerialHits],
        ["Boost collected", stats.boostCollected],
        ["Kickoff record", `${display.kickoffWins}-${display.kickoffLosses}-${display.kickoffDraws}`],
        ["Kickoff win rate", formatPercentage(display.kickoffWinPercentage)],
        ["Own goals", stats.ownGoals]
    ];
    const status = `Last ${display.games} of ${summary.games} tracked matches · ` +
        `${display.wins}W-${display.losses}L-${display.draws}D · ` +
        `${Math.round(display.wins / display.games * 100)}% win rate`;

    return (
        <>
            <div className="subtitle">{status}</div>
            <div className="history-layout">
                <div>
                    <section className="recent-games" aria-label="Recent game results">
                        <h2>Last 20 games</h2>
                        <GameSequence games={summary.recentGames} />
                    </section>
                    <div className="history-summary">
                        {cards.map(([label, value]) => (
                            <HistoryCard key={label} label={label} value={value} />
                        ))}
                    </div>
                </div>
                <OpponentTable opponents={summary.opponents} />
            </div>
        </>
    );
}
