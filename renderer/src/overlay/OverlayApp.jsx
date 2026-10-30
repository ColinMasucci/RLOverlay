import React, { useEffect, useState } from "react";
import Heatmap from "./Heatmap.jsx";
import MatchHistory from "./MatchHistory.jsx";
import Scoreboard from "./Scoreboard.jsx";

const initialHistory = {
    summary: { games: 0, recentGames: [], opponents: [], display: { games: 0 } },
    totalMatches: 0,
    trackedPlayerId: null,
    error: null
};

export default function OverlayApp() {
    const [players, setPlayers] = useState([]);
    const [samples, setSamples] = useState([]);
    const [history, setHistory] = useState(initialHistory);
    const [settings, setSettings] = useState(null);
    const [view, setView] = useState("scoreboard");

    useEffect(() => {
        const api = window.rocketLeague;
        const unsubscribers = [
            api.onPlayersUpdated(setPlayers),
            api.onHeatmapUpdated(setSamples),
            api.onMatchHistoryUpdated(setHistory),
            api.onOverlayViewUpdated(setView),
            api.onSettingsUpdated(setSettings)
        ];
        return () => unsubscribers.forEach((unsubscribe) => unsubscribe?.());
    }, []);

    const statVisibility = settings?.statVisibility ?? {};
    const heatmapMode = settings?.heatmapMode ?? "overall";
    const showHeatmap = settings?.showHeatmap !== false;
    const historyShortcut = settings?.keyboard?.toggleHistory ?? "F11";
    const settingsShortcut = settings?.keyboard?.toggleSettings ?? "F10";
    const trackedPlayerId = settings?.trackedPlayerId;
    const trackedPlayer = trackedPlayerId
        ? players.find((player) => {
            const playerId = typeof player.id === "string" && player.id.trim()
                ? player.id.trim()
                : `name:${String(player.name ?? "").trim().toLowerCase()}`;
            return playerId === trackedPlayerId;
        })
        : null;
    const userTeam = trackedPlayer?.team === 0 || trackedPlayer?.team === 1
        ? trackedPlayer.team
        : 0;
    const showingHistory = view === "history";

    return (
        <main className="overlay-panel">
            <h1>
                {showingHistory
                    ? `MATCH HISTORY · ${historyShortcut} TO RETURN`
                    : `SCOREBOARD · ${historyShortcut} FOR HISTORY`}
            </h1>
            {showingHistory
                ? <section className="history-view"><MatchHistory history={history} settingsShortcut={settingsShortcut} /></section>
                : (
                    <div className={`overlay-content${showHeatmap ? "" : " heatmap-hidden"}`}>
                        <Scoreboard players={players} statVisibility={statVisibility} />
                        {showHeatmap && (
                            <Heatmap samples={samples} mode={heatmapMode} userTeam={userTeam} />
                        )}
                    </div>
                )}
        </main>
    );
}
