const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const WebSocket = require("ws");
const { createImposterServer } = require("../imposter-server");

const servers = [];
const sockets = [];

after(async () => {
    for (const socket of sockets) {
        socket.terminate();
    }
    await Promise.all(servers.map((server) => server.close()));
});

function waitForMessage(socket, predicate) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.removeListener("message", onMessage);
            reject(new Error("Timed out waiting for lobby response."));
        }, 3000);
        function onMessage(raw) {
            const message = JSON.parse(raw.toString());
            if (!predicate(message)) {
                return;
            }
            clearTimeout(timeout);
            socket.removeListener("message", onMessage);
            resolve(message);
        }
        socket.on("message", onMessage);
    });
}

async function connect(address) {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    sockets.push(socket);
    await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
    });
    return socket;
}

function send(socket, value) {
    socket.send(JSON.stringify(value));
}

test("lobby config starts a round and completes secret voting", async () => {
    const server = createImposterServer({ port: 0 });
    servers.push(server);
    const address = await server.listen();
    const host = await connect(address);
    const hostJoined = waitForMessage(host, (message) => message.type === "joined");
    const hostLobby = waitForMessage(host, (message) => message.type === "room");
    send(host, { type: "create", name: "Host" });
    const { playerId: hostId } = await hostJoined;
    const { room: createdRoom } = await hostLobby;
    assert.equal(createdRoom.players.length, 1);

    const guest = await connect(address);
    const guestJoined = waitForMessage(guest, (message) => message.type === "joined");
    const guestLobby = waitForMessage(guest, (message) => message.type === "room");
    send(guest, { type: "join", code: createdRoom.code, name: "Guest" });
    const { playerId: guestId } = await guestJoined;
    await guestLobby;

    const configured = waitForMessage(host, (message) =>
        message.type === "room" && message.room.settings.enabledChallenges[0] === "own_goal"
    );
    send(host, {
        type: "settings",
        imposterCount: 1,
        challengeAssignment: "same",
        enabledChallenges: ["own_goal"]
    });
    await configured;

    const hostReady = waitForMessage(host, (message) =>
        message.type === "room" && message.room.phase === "playing"
    );
    const guestReady = waitForMessage(guest, (message) =>
        message.type === "room" && message.room.phase === "playing"
    );
    send(host, { type: "ready", ready: true });
    send(guest, { type: "ready", ready: true });
    const hostRound = await hostReady;
    const guestRound = await guestReady;
    assert.equal(
        Number(hostRound.role === "imposter") + Number(guestRound.role === "imposter"),
        1
    );
    assert.equal(hostRound.challenge ?? guestRound.challenge, "own_goal");
    assert.equal("role" in hostRound.room.players[0], false);

    const imposterSocket = hostRound.role === "imposter" ? host : guest;
    const imposterId = hostRound.role === "imposter" ? hostId : guestId;
    const otherSocket = hostRound.role === "imposter" ? guest : host;
    const ownProgress = waitForMessage(imposterSocket, (message) =>
        message.type === "room" && message.room.phase === "playing" &&
        message.room.players.find((player) => player.id === imposterId)?.challengeComplete === true
    );
    const hiddenProgress = waitForMessage(otherSocket, (message) =>
        message.type === "room" && message.room.phase === "playing" &&
        message.room.players.some((player) => player.id === imposterId)
    );
    send(imposterSocket, {
        type: "game-stats",
        playerName: hostRound.role === "imposter" ? "Host" : "Guest",
        ownGoals: 1,
        demos: 0,
        goals: 0
    });
    const [imposterUpdate, otherUpdate] = await Promise.all([ownProgress, hiddenProgress]);
    assert.equal(
        imposterUpdate.room.players.find((player) => player.id === imposterId).challengeComplete,
        true
    );
    assert.equal(
        otherUpdate.room.players.find((player) => player.id === imposterId).challengeComplete,
        null
    );

    const hostResult = waitForMessage(host, (message) =>
        message.type === "room" && message.room.phase === "results"
    );
    const guestResult = waitForMessage(guest, (message) =>
        message.type === "room" && message.room.phase === "results"
    );
    send(host, { type: "match-ended" });
    const hostVoting = waitForMessage(host, (message) =>
        message.type === "room" && message.room.phase === "voting"
    );
    const guestVoting = waitForMessage(guest, (message) =>
        message.type === "room" && message.room.phase === "voting"
    );
    await Promise.all([hostVoting, guestVoting]);
    const selfVoteError = waitForMessage(host, (message) => message.type === "error");
    send(host, { type: "vote", suspects: [hostId] });
    assert.match((await selfVoteError).message, /Select exactly one other player/);
    send(host, { type: "vote", suspects: [guestId] });
    send(guest, { type: "vote", suspects: [hostId] });
    const [hostFinal, guestFinal] = await Promise.all([hostResult, guestResult]);
    assert.equal(hostFinal.results.submittedVotes, 2);
    assert.equal(hostFinal.results.roles[hostId], hostRound.role);
    assert.deepEqual(hostFinal.results.tally, guestFinal.results.tally);
});
