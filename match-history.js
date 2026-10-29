const statFields = [
    "score",
    "goals",
    "assists",
    "saves",
    "shots",
    "demos",
    "touches",
    "carTouches",
    "postHits",
    "boostCollected",
    "aerialHits",
    "kickoffWins",
    "kickoffAttempts",
    "ownGoals"
];

const apiStatFields = {
    score: "Score",
    goals: "Goals",
    assists: "Assists",
    saves: "Saves",
    shots: "Shots",
    demos: "Demos",
    touches: "Touches",
    carTouches: "CarTouches",
    kickoffWins: "KickoffWins",
    kickoffAttempts: "KickoffAttempts",
    ownGoals: "OwnGoals"
};

function getPlayerId(player) {
    if (!player || typeof player !== "object") {
        return null;
    }
    if (typeof player.id === "string" && player.id.trim()) {
        return player.id.trim();
    }
    if (typeof player.PrimaryId === "string" && player.PrimaryId.trim()) {
        return player.PrimaryId.trim();
    }

    const name = player.name ?? player.Name;
    return typeof name === "string" && name.trim()
        ? `name:${name.trim().toLowerCase()}`
        : null;
}

function isBotPlayer(player) {
    const id = getPlayerId(player);
    if (!id) {
        return false;
    }

    const idParts = id.split("|");
    const numericId = idParts[1]?.trim();
    return id === "1" || numericId === "0" || numericId === "1";
}

function normalizePlayer(player) {
    const name = player.name ?? player.Name;
    const team = player.team ?? player.TeamNum;
    const id = getPlayerId(player);
    if (!id || typeof name !== "string" || (team !== 0 && team !== 1)) {
        return null;
    }

    const stats = {};
    for (const field of statFields) {
        const apiField = apiStatFields[field];
        const value = player[field] ?? (apiField ? player[apiField] : undefined);
        stats[field] = Number.isFinite(value) ? value : 0;
    }

    return { id, name, team, stats };
}

function createMatchRecord(
    matchId,
    players,
    finishedAt = new Date().toISOString(),
    kickoffDuels = []
) {
    const participants = (players ?? []).map(normalizePlayer).filter(Boolean);
    if (participants.length === 0) {
        return null;
    }

    const teamGoals = [0, 0];
    for (const player of participants) {
        teamGoals[player.team] += player.stats.goals;
    }

    return {
        id: String(matchId || finishedAt),
        finishedAt,
        teamGoals,
        players: participants,
        kickoffDuels: kickoffDuels.filter((duel) =>
            duel && typeof duel.bluePlayerId === "string" &&
            typeof duel.orangePlayerId === "string" &&
            (duel.winnerId === null || typeof duel.winnerId === "string")
        )
    };
}

function listPlayerOptions(matches, currentPlayers = []) {
    const options = new Map();
    for (const player of [...currentPlayers, ...matches.flatMap((match) => match.players)]) {
        if (isBotPlayer(player)) {
            continue;
        }
        const normalized = normalizePlayer(player);
        if (normalized) {
            options.set(normalized.id, { id: normalized.id, name: normalized.name });
        }
    }
    return [...options.values()].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    );
}

function createTotals() {
    return Object.fromEntries(statFields.map((field) => [field, 0]));
}

function aggregateMatchScope(matches, trackedPlayerId, currentOpponentIds = new Set()) {
    const aggregate = {
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        kickoffWins: 0,
        kickoffAttempts: 0,
        kickoffLosses: 0,
        kickoffDraws: 0,
        stats: createTotals(),
        opponents: [],
        recentGames: []
    };
    if (!trackedPlayerId) {
        return aggregate;
    }

    const opponentTotals = new Map();
    for (const match of matches) {
        const tracked = match.players.find((player) => player.id === trackedPlayerId);
        if (!tracked || isBotPlayer(tracked)) {
            continue;
        }

        const goalsFor = match.teamGoals[tracked.team];
        const goalsAgainst = match.teamGoals[1 - tracked.team];
        aggregate.games += 1;
        aggregate.goalsFor += goalsFor;
        aggregate.goalsAgainst += goalsAgainst;
        for (const field of statFields) {
            aggregate.stats[field] += tracked.stats[field] ?? 0;
        }

        const outcome = goalsFor > goalsAgainst
            ? "wins"
            : goalsFor < goalsAgainst
                ? "losses"
                : "draws";
        aggregate[outcome] += 1;
        aggregate.recentGames.push({
            id: match.id,
            finishedAt: match.finishedAt,
            outcome: outcome === "wins" ? "win" : outcome === "losses" ? "loss" : "draw"
        });

        const opponentsInMatch = new Set();
        for (const opponent of match.players) {
            if (opponent.team === tracked.team || isBotPlayer(opponent) ||
                opponentsInMatch.has(opponent.id)) {
                continue;
            }
            opponentsInMatch.add(opponent.id);
            const record = opponentTotals.get(opponent.id) ?? {
                id: opponent.id,
                name: opponent.name,
                isCurrentMatch: currentOpponentIds.has(opponent.id),
                games: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                goalsFor: 0,
                goalsAgainst: 0,
                kickoffWins: 0,
                kickoffLosses: 0,
                kickoffDraws: 0,
                kickoffAttempts: 0
            };
            record.name = opponent.name;
            record.isCurrentMatch = currentOpponentIds.has(opponent.id);
            record.games += 1;
            record[outcome] += 1;
            record.goalsFor += goalsFor;
            record.goalsAgainst += goalsAgainst;
            opponentTotals.set(opponent.id, record);
        }

        for (const duel of match.kickoffDuels ?? []) {
            const trackedWasBlue = duel.bluePlayerId === trackedPlayerId;
            const trackedWasOrange = duel.orangePlayerId === trackedPlayerId;
            if (!trackedWasBlue && !trackedWasOrange) {
                continue;
            }
            const opponentId = trackedWasBlue ? duel.orangePlayerId : duel.bluePlayerId;
            const record = opponentTotals.get(opponentId);
            if (!record) {
                continue;
            }
            record.kickoffAttempts += 1;
            if (duel.winnerId === trackedPlayerId) {
                record.kickoffWins += 1;
                aggregate.kickoffWins += 1;
            } else if (duel.winnerId === opponentId) {
                record.kickoffLosses += 1;
                aggregate.kickoffLosses += 1;
            } else {
                record.kickoffDraws += 1;
                aggregate.kickoffDraws += 1;
            }
        }
    }

    aggregate.kickoffWins = aggregate.stats.kickoffWins;
    aggregate.kickoffAttempts = aggregate.stats.kickoffAttempts;
    aggregate.kickoffLosses = Math.max(
        0,
        aggregate.kickoffAttempts - aggregate.kickoffWins - aggregate.kickoffDraws
    );
    aggregate.kickoffWinPercentage = aggregate.kickoffAttempts > 0
        ? aggregate.kickoffWins / aggregate.kickoffAttempts * 100
        : null;
    for (const opponent of opponentTotals.values()) {
        opponent.kickoffWinPercentage = opponent.kickoffAttempts > 0
            ? opponent.kickoffWins / opponent.kickoffAttempts * 100
            : null;
    }
    aggregate.opponents = [...opponentTotals.values()].sort((left, right) =>
        Number(right.isCurrentMatch) - Number(left.isCurrentMatch) ||
        right.games - left.games ||
        left.name.localeCompare(right.name)
    );
    return aggregate;
}

function aggregateMatches(matches, trackedPlayerId, currentPlayers = []) {
    const trackedPlayer = matches
        .flatMap((match) => match.players)
        .find((player) => player.id === trackedPlayerId && !isBotPlayer(player));
    const currentOpponentIds = new Set(
        (currentPlayers ?? [])
            .filter((player) => {
                const normalized = normalizePlayer(player);
                return normalized && !isBotPlayer(player) &&
                    player.active !== false &&
                    (!trackedPlayer || normalized.team !== trackedPlayer.team);
            })
            .map((player) => getPlayerId(player))
            .filter(Boolean)
    );
    const trackedMatches = matches
        .filter((match) => match.players.some((player) =>
            player.id === trackedPlayerId && !isBotPlayer(player)
        ))
        .sort((left, right) =>
            right.finishedAt.localeCompare(left.finishedAt) ||
            right.id.localeCompare(left.id)
        );
    const mostRecent20 = trackedMatches.slice(0, 20);
    const mostRecent10 = trackedMatches.slice(0, 10);
    const overall = aggregateMatchScope(trackedMatches, trackedPlayerId);
    const display = aggregateMatchScope(mostRecent20, trackedPlayerId);
    const headToHead = aggregateMatchScope(mostRecent10, trackedPlayerId, currentOpponentIds);

    return {
        ...overall,
        recentGames: display.recentGames,
        display,
        opponents: headToHead.opponents
    };
}

module.exports = {
    aggregateMatches,
    createMatchRecord,
    getPlayerId,
    isBotPlayer,
    listPlayerOptions,
    statFields
};
