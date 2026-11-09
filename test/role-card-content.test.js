const test = require("node:test");
const assert = require("node:assert/strict");

test("role card content reveals challenge only to an active imposter", async () => {
    const { getRoleCardContent } = await import("../renderer/src/party/role-card-content.mjs");
    const settings = { gameMode: "challenge", speedUnit: "kph" };

    assert.deepEqual(getRoleCardContent({
        role: "imposter",
        settings,
        challengeLabel: "Get three assists",
        roleHidden: false
    }), {
        label: "IMPOSTER",
        task: "Your task: Get three assists.",
        isSafe: false
    });
    assert.deepEqual(getRoleCardContent({
        role: "safe",
        settings,
        challengeLabel: "Get three assists",
        roleHidden: false
    }), {
        label: "SAFE",
        task: "There is an imposter among you. Guess who they are and their task.",
        isSafe: true
    });
});

test("a hidden speed imposter receives a safe-looking separate target", async () => {
    const { getRoleCardContent } = await import("../renderer/src/party/role-card-content.mjs");

    assert.deepEqual(getRoleCardContent({
        role: "imposter",
        settings: { gameMode: "speed", speedUnit: "mph" },
        speedTarget: 47,
        roleHidden: true
    }), {
        label: "SAFE",
        task: "Try to score a goal at 47 MPH. Let your team know how it went.",
        isSafe: true
    });
});
