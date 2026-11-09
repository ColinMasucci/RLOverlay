const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    DEFAULT_PACKET_SEND_RATE,
    ensureStatsApiConfig,
    setStatsApiPacketRate
} = require("../stats-api-config");

function createConfigDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rloverlay-stats-api-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test("creates DefaultStatsAPI.ini with rate 10 when neither config exists", (t) => {
    const directory = createConfigDirectory(t);
    const result = ensureStatsApiConfig(directory);
    const contents = fs.readFileSync(result.filePath, "utf8");

    assert.equal(path.basename(result.filePath), "DefaultStatsAPI.ini");
    assert.equal(result.rate, DEFAULT_PACKET_SEND_RATE);
    assert.equal(result.created, true);
    assert.match(contents, /\[TAGame\.MatchStatsExporter_TA\]/);
    assert.match(contents, /PacketSendRate=10/);
});

test("preserves an existing TAStatsAPI rate and unrelated INI sections", (t) => {
    const directory = createConfigDirectory(t);
    const filePath = path.join(directory, "TAStatsAPI.ini");
    const original = [
        "[TAGame.MatchStatsExporter_TA]",
        "Port=49123",
        "WebPort=49124",
        "PacketSendRate=30",
        "",
        "[IniVersion]",
        "0=12345",
        ""
    ].join("\r\n");
    fs.writeFileSync(filePath, original);

    const result = ensureStatsApiConfig(directory);

    assert.equal(result.filePath, filePath);
    assert.equal(result.rate, 30);
    assert.equal(fs.readFileSync(filePath, "utf8"), original);
});

test("setting a rate preserves other lines and creates a one-time backup", (t) => {
    const directory = createConfigDirectory(t);
    const filePath = path.join(directory, "TAStatsAPI.ini");
    fs.writeFileSync(filePath, [
        "[TAGame.MatchStatsExporter_TA]",
        "Port=49123",
        "PacketSendRate=10 ; user setting",
        "",
        "[IniVersion]",
        "0=12345"
    ].join("\n"));

    const result = setStatsApiPacketRate(directory, 60);
    const contents = fs.readFileSync(filePath, "utf8");

    assert.equal(result.rate, 60);
    assert.match(contents, /Port=49123/);
    assert.match(contents, /PacketSendRate=60 ; user setting/);
    assert.match(contents, /\[IniVersion\]/);
    assert.equal(fs.readFileSync(`${filePath}.RLOverlay.bak`, "utf8").includes("PacketSendRate=10"), true);

    setStatsApiPacketRate(directory, 45);
    assert.equal(fs.readFileSync(`${filePath}.RLOverlay.bak`, "utf8").includes("PacketSendRate=10"), true);
});

test("uses DefaultStatsAPI.ini when TAStatsAPI.ini is absent", (t) => {
    const directory = createConfigDirectory(t);
    const filePath = path.join(directory, "DefaultStatsAPI.ini");
    fs.writeFileSync(filePath, "[Other]\nKeep=1\n");

    const result = ensureStatsApiConfig(directory);

    assert.equal(result.filePath, filePath);
    assert.equal(result.rate, 10);
    assert.match(fs.readFileSync(filePath, "utf8"), /PacketSendRate=10/);
    assert.match(fs.readFileSync(filePath, "utf8"), /Keep=1/);
});

test("rejects packet rates outside the supported range", (t) => {
    const directory = createConfigDirectory(t);

    assert.throws(() => setStatsApiPacketRate(directory, 0), /whole number from 1 to 120/);
    assert.throws(() => setStatsApiPacketRate(directory, 121), /whole number from 1 to 120/);
    assert.throws(() => setStatsApiPacketRate(directory, 10.5), /whole number from 1 to 120/);
});
