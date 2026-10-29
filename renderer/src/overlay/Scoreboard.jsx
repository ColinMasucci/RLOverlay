import React from "react";
import PlatformIcon, { getPlatform } from "./PlatformIcon.jsx";

const statColumns = [
    ["score", "Score"],
    ["goals", "Goals"],
    ["assists", "Assists"],
    ["saves", "Saves"],
    ["shots", "Shots"],
    ["demos", "Demos"],
    ["touches", "Ball touches"],
    ["carTouches", "Car touches"],
    ["postHits", "Post hits"],
    ["boostCollected", "Boost collected"],
    ["aerialHits", "Aerial hits"],
    ["kickoffWins", "Kickoff wins"],
    ["ownGoals", "Own goals"]
];

function RankBadge({ rank }) {
    if (!rank?.rank || !rank?.mmr) return null;
    return (
        <div className="rank-display" title={`Peak ${rank.rank} in 2v2`}>
            {rank.logo
                ? <img src={rank.logo} alt={rank.rank} loading="lazy" referrerPolicy="no-referrer" />
                : <span>{rank.rank}</span>}
            <span>{rank.mmr} MMR</span>
        </div>
    );
}

function PlayerRow({ player, team }) {
    return (
        <tr className={`${team === 0 ? "blue-player" : "orange-player"}${player.active === false ? " inactive-player" : ""}`}>
            <td>
                <div className="identity">
                    <PlatformIcon platform={getPlatform(player.id)} />
                    <div className="name">{player.name}</div>
                    <RankBadge rank={player.trackerRank} />
                </div>
            </td>
            {statColumns.filter(([key]) => statVisibility[key] !== false).map(([key]) => (
                <td key={key}>
                    {Number.isFinite(player[key]) ? player[key] : 0}
                </td>
            ))}
        </tr>
    );
}

function TeamSection({ team, players, statVisibility }) {
    const visibleStatColumns = statColumns.filter(([key]) => statVisibility[key] !== false);
    const columnCount = visibleStatColumns.length + 1;
    const statColumnWidth = visibleStatColumns.length
        ? `${76 / visibleStatColumns.length}%`
        : "0%";
    const teamPlayers = players
        .filter((player) =>
            player.team === team &&
            !(getPlatform(player.id) === "Bot" && player.score === 0)
        )
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
    const teamName = team === 0 ? "Blue Team" : "Orange Team";

    return (
        <section className="team-section">
            <table>
                <colgroup>
                    <col style={{ width: "24%" }} />
                    {visibleStatColumns.map(([key]) => (
                        <col key={key} style={{ width: statColumnWidth }} />
                    ))}
                </colgroup>
                <thead>
                    <tr className={`team-heading ${team === 0 ? "blue-heading" : "orange-heading"}`}>
                        <th scope="col" colSpan={columnCount}>
                            <div
                                className="scoreboard-heading"
                                style={{
                                    gridTemplateColumns:
                                        `24% repeat(${visibleStatColumns.length}, minmax(0, 1fr))`
                                }}
                            >
                                <span className="scoreboard-heading-team">{teamName}</span>
                                {visibleStatColumns.map(([key, label]) => (
                                    <span
                                        key={key}
                                        data-stat={key}
                                        className="scoreboard-heading-stat"
                                    >
                                        {label}
                                    </span>
                                ))}
                            </div>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {teamPlayers.length
                        ? teamPlayers.map((player, index) => (
                            <PlayerRow
                                key={`${player.id || player.name}-${player.team}-${index}`}
                                player={player}
                                team={team}
                            />
                        ))
                        : (
                            <tr>
                                <td className="empty" colSpan={columnCount}>
                                    {players.length ? "No players" : "Waiting for player data..."}
                                </td>
                            </tr>
                        )}
                </tbody>
            </table>
        </section>
    );
}

export default function Scoreboard({ players, statVisibility }) {
    const activeCount = players.filter((player) => player.active !== false).length;
    const departedCount = players.length - activeCount;
    const status = players.length === 0
        ? "No players in the current match"
        : departedCount > 0
            ? `${activeCount} active · ${departedCount} left this match`
            : `${activeCount} players detected`;

    return (
        <div className="scoreboard-column">
            <div className="subtitle overlay-status">{status}</div>
            <div className="teams">
                <TeamSection team={0} players={players} statVisibility={statVisibility} />
                <TeamSection team={1} players={players} statVisibility={statVisibility} />
            </div>
        </div>
    );
}
