const KICKOFF_OPPONENT_HALF_BUFFER = 600;

function createKickoffState() {
    return {
        active: false,
        lastTouchByTeam: new Map()
    };
}

function startKickoff(state) {
    state.active = true;
    state.lastTouchByTeam.clear();
}

function finishKickoff(state, winnerTeam, players = []) {
    if (!state.active || (winnerTeam !== 0 && winnerTeam !== 1)) {
        return null;
    }

    const rosterByTeam = [0, 1].map((team) =>
        (players ?? []).filter((player) => player.TeamNum === team && player.Name)
    );
    if (rosterByTeam.every((teamPlayers) => teamPlayers.length === 1)) {
        for (const team of [0, 1]) {
            if (!state.lastTouchByTeam.has(team)) {
                state.lastTouchByTeam.set(team, rosterByTeam[team][0]);
            }
        }
    }

    const participants = [...state.lastTouchByTeam.entries()].map(([team, player]) => ({
        team,
        player
    }));
    const winner = state.lastTouchByTeam.get(winnerTeam) ?? null;
    state.active = false;
    state.lastTouchByTeam.clear();

    return {
        winner,
        winnerTeam,
        participants
    };
}

function registerKickoffBallHit(state, touchers, location) {
    if (!state.active) {
        return null;
    }

    for (const player of touchers ?? []) {
        if ((player.TeamNum === 0 || player.TeamNum === 1) && player.Name) {
            state.lastTouchByTeam.set(player.TeamNum, player);
        }
    }

    if (!location || !Number.isFinite(location.Y) ||
        Math.abs(location.Y) <= KICKOFF_OPPONENT_HALF_BUFFER) {
        return null;
    }

    const attackingTeam = location.Y > 0 ? 0 : 1;
    return finishKickoff(state, attackingTeam);
}

function resolveKickoffGoal(state, scoringTeam, players) {
    return finishKickoff(state, scoringTeam, players);
}

function getTeamGoalTotals(players) {
    return [0, 1].map((team) => (players ?? [])
        .filter((player) => player.TeamNum === team)
        .reduce((total, player) => total + (Number.isFinite(player.Goals) ? player.Goals : 0), 0)
    );
}

module.exports = {
    KICKOFF_OPPONENT_HALF_BUFFER,
    createKickoffState,
    getTeamGoalTotals,
    registerKickoffBallHit,
    resolveKickoffGoal,
    startKickoff
};
