const test = require("node:test");
const assert = require("node:assert/strict");
const {
    aggregateMatches,
    createMatchRecord,
    suggestTrackedPlayerId
} = require("../match-history");

function player(id, name, team) {
    return { id: `steam|${id}`, name, team, goals: 0 };
}

function match(id, players, finishedAt = `2026-01-${String(id).padStart(2, "0")}T12:00:00.000Z`) {
    return createMatchRecord(String(id), players, finishedAt);
}

test("suggestTrackedPlayerId selects a unique human present in every saved match", () => {
    const matches = [
        match(1, [player("100", "Me", 0), player("200", "Teammate", 0)]),
        match(2, [player("100", "Me", 1), player("201", "Other", 0)]),
        match(3, [player("100", "Me", 0), player("202", "Another", 1)])
    ];

    assert.equal(suggestTrackedPlayerId(matches), "steam|100");
});

test("suggestTrackedPlayerId does not guess with too little or ambiguous history", () => {
    assert.equal(suggestTrackedPlayerId([
        match(1, [player("100", "Me", 0)])
    ]), null);
    assert.equal(suggestTrackedPlayerId([
        match(1, [player("100", "One", 0), player("200", "Two", 1)]),
        match(2, [player("100", "One", 0), player("200", "Two", 1)]),
        match(3, [player("100", "One", 0), player("200", "Two", 1)])
    ]), null);
    assert.equal(suggestTrackedPlayerId([
        match(1, [player("100", "Me", 0)]),
        match(2, [player("100", "Me", 0)]),
        match(3, [player("200", "Other", 1)])
    ]), null);
});

test("spectators are excluded from archived match participants and tracked records", () => {
    const spectator = {
        ...player("100", "Me", 0),
        isSpectator: true
    };
    const record = match(1, [
        spectator,
        player("200", "Opponent", 1)
    ]);

    assert.deepEqual(record.players.map((matchPlayer) => matchPlayer.id), ["steam|200"]);
    assert.equal(aggregateMatches([record], "steam|100").games, 0);
});

test("head-to-head lists at most fifteen recent opponents and pins current opponents", () => {
    const tracked = player("100", "Me", 0);
    const matches = Array.from({ length: 20 }, (_, index) =>
        match(index + 1, [
            tracked,
            player(String(200 + index), `Opponent ${index + 1}`, 1)
        ])
    );
    const currentPlayers = [
        { ...tracked, active: true },
        { ...player("999", "Current opponent", 1), active: true }
    ];

    const opponents = aggregateMatches(matches, tracked.id, currentPlayers).opponents;

    assert.equal(opponents.length, 15);
    assert.equal(opponents[0].id, "steam|999");
    assert.equal(opponents[0].isCurrentMatch, true);
    assert.equal(opponents[0].games, 0);
    assert.deepEqual(
        opponents.slice(1).map((opponent) => opponent.name),
        Array.from({ length: 14 }, (_, index) => `Opponent ${20 - index}`)
    );
});
