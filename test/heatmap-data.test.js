const test = require("node:test");
const assert = require("node:assert/strict");

test("getZoneTouchShares calculates touch share by oriented field third", async () => {
    const { getZoneTouchShares } = await import("../renderer/src/overlay/heatmap-data.mjs");
    const samples = [
        { y: 3000, isTouch: true },
        { y: 2000, isTouch: true },
        { y: 0, isTouch: true },
        { y: -3000, isTouch: true },
        { y: -3000, isTouch: false }
    ];

    assert.deepEqual(getZoneTouchShares(samples, 0), [50, 25, 25]);
    assert.deepEqual(getZoneTouchShares(samples, 1), [25, 25, 50]);
});

test("getZoneTouchShares reports no percentages before any ball touches", async () => {
    const { getZoneTouchShares } = await import("../renderer/src/overlay/heatmap-data.mjs");
    assert.deepEqual(getZoneTouchShares([{ y: 2500, isTouch: false }], 0), [
        null, null, null
    ]);
});
