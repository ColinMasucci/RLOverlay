const test = require("node:test");
const assert = require("node:assert/strict");
const {
    getGroundState,
    isMatchParticipant,
    recordAerialHit
} = require("../match-events");

test("ground state accepts supported API field names and boolean-like values", () => {
    assert.equal(getGroundState({ bOnGround: false }), false);
    assert.equal(getGroundState({ OnGround: 0 }), false);
    assert.equal(getGroundState({ onGround: 1 }), true);
    assert.equal(getGroundState({ Car: { bOnGround: true } }), true);
    assert.equal(getGroundState({}), undefined);
});

test("only non-spectator team players qualify as match participants", () => {
    assert.equal(isMatchParticipant({ TeamNum: 0, Name: "Player" }), true);
    assert.equal(isMatchParticipant({ TeamNum: 1, Name: "Player", bIsSpectator: true }), false);
    assert.equal(isMatchParticipant({ TeamNum: 255, Name: "Spectator" }), false);
});

test("aerial hits use the latest known grounded state and ignore unknown states", () => {
    const counts = new Map();
    const motion = new Map([["player", { onGround: false }]]);

    assert.equal(recordAerialHit(counts, motion, "player", { bOnGround: true }), true);
    assert.equal(counts.get("player"), 1);
    assert.equal(recordAerialHit(counts, motion, "player", {}), true);
    assert.equal(counts.get("player"), 2);

    motion.set("player", { onGround: true });
    assert.equal(recordAerialHit(counts, motion, "player", { bOnGround: false }), false);
    assert.equal(counts.get("player"), 2);
    assert.equal(recordAerialHit(counts, new Map(), "unknown", {}), false);
});
