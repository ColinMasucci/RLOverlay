const http = require("node:http");
const crypto = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");
const challenges = require("./shared/imposter-challenges.json");

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_PLAYERS = 12;
const MAX_ROOMS = 1000;
const MAX_NAME_LENGTH = 24;
const MAX_LOBBY_ATTEMPTS_PER_MINUTE = 20;
const DEFAULT_CHALLENGES = challenges.map(({ id }) => id);

function randomToken(bytes = 24) {
    return crypto.randomBytes(bytes).toString("base64url");
}

function makeRoomCode(rooms) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        let code = "";
        for (let index = 0; index < 6; index += 1) {
            code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
        }
        if (!rooms.has(code)) {
            return code;
        }
    }
    throw new Error("Could not allocate a unique lobby code.");
}

function normalizeName(value) {
    if (typeof value !== "string") {
        return null;
    }
    const name = value.trim().replace(/\s+/g, " ");
    return name && name.length <= MAX_NAME_LENGTH ? name : null;
}

function getPublicRoom(room, viewerId) {
    return {
        code: room.code,
        phase: room.phase,
        settings: {
            imposterCount: room.settings.imposterCount,
            challengeAssignment: room.settings.challengeAssignment,
            enabledChallenges: room.settings.enabledChallenges
        },
        players: [...room.players.values()].map((player) => ({
            id: player.id,
            name: player.name,
            isHost: player.token === room.hostToken,
            ready: player.ready,
            voted: room.votes.has(player.id),
            challengeComplete: room.phase === "results" || player.id === viewerId
                ? player.challengeComplete
                : null
        }))
    };
}

function send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

function createImposterServer({ port = Number(process.env.PORT) || 3001, host = "0.0.0.0" } = {}) {
    const rooms = new Map();
    const socketPlayers = new Map();
    const lobbyAttempts = new Map();
    const httpServer = http.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ service: "rloverlay-imposter", status: "ok" }));
    });
    const webSocketServer = new WebSocketServer({
        server: httpServer,
        maxPayload: 4096
    });

    function sendRoom(room) {
        for (const player of room.players.values()) {
            send(player.socket, {
                type: "room",
                room: getPublicRoom(room, player.id),
                role: player.role,
                challenge: player.challenge,
                results: room.phase === "results" ? room.results : null
            });
        }
    }

    function removePlayer(room, player) {
        room.players.delete(player.id);
        if (room.hostToken === player.token) {
            room.hostToken = room.players.values().next().value?.token ?? null;
        }
        if (room.players.size === 0) {
            rooms.delete(room.code);
            return;
        }
        if (room.phase === "lobby") {
            room.settings.imposterCount = Math.min(
                room.settings.imposterCount,
                room.players.size
            );
        }
        sendRoom(room);
    }

    function issueError(socket, message) {
        send(socket, { type: "error", message });
    }

    function allowLobbyAttempt(socket) {
        const address = socket.clientAddress || "unknown";
        const now = Date.now();
        if (lobbyAttempts.size > 5000) {
            for (const [key, timestamps] of lobbyAttempts) {
                if (timestamps.every((timestamp) => now - timestamp >= 60_000)) {
                    lobbyAttempts.delete(key);
                }
            }
        }
        const recent = (lobbyAttempts.get(address) ?? [])
            .filter((timestamp) => now - timestamp < 60_000);
        if (recent.length >= MAX_LOBBY_ATTEMPTS_PER_MINUTE) {
            return false;
        }
        recent.push(now);
        lobbyAttempts.set(address, recent);
        return true;
    }

    function getPlayer(socket) {
        const entry = socketPlayers.get(socket);
        if (!entry) {
            return null;
        }
        const room = rooms.get(entry.code);
        const player = room?.players.get(entry.id);
        return room && player ? { room, player } : null;
    }

    function startRound(room) {
        const players = [...room.players.values()];
        if (room.phase !== "lobby" || players.length < 2 ||
            players.some((player) => !player.ready)) {
            return;
        }

        const imposterCount = Math.min(room.settings.imposterCount, players.length);
        const shuffled = [...players];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
            const swapIndex = crypto.randomInt(index + 1);
            [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
        }
        const imposters = new Set(shuffled.slice(0, imposterCount).map((player) => player.id));
        const enabled = room.settings.enabledChallenges;
        const selectedChallenge = enabled[crypto.randomInt(enabled.length)];

        room.phase = "playing";
        room.votes.clear();
        room.results = null;
        for (const player of players) {
            player.role = imposters.has(player.id) ? "imposter" : "safe";
            player.challenge = player.role === "imposter"
                ? room.settings.challengeAssignment === "same"
                    ? selectedChallenge
                    : enabled[crypto.randomInt(enabled.length)]
                : null;
        }
        sendRoom(room);
    }

    function finishVoting(room) {
        if (room.phase !== "voting") {
            return;
        }
        const tally = Object.fromEntries([...room.players.keys()].map((id) => [id, 0]));
        for (const suspects of room.votes.values()) {
            for (const suspectId of suspects) {
                if (Object.hasOwn(tally, suspectId)) {
                    tally[suspectId] += 1;
                }
            }
        }
        room.phase = "results";
        room.results = {
            tally,
            roles: Object.fromEntries([...room.players.values()].map((player) => [
                player.id,
                player.role
            ])),
            submittedVotes: room.votes.size
        };
        sendRoom(room);
    }

    function handleMessage(socket, rawMessage) {
        let message;
        try {
            message = JSON.parse(rawMessage.toString());
        } catch {
            issueError(socket, "Message must be valid JSON.");
            return;
        }
        if (!message || typeof message !== "object" || typeof message.type !== "string") {
            issueError(socket, "Message type is required.");
            return;
        }

        if (message.type === "create") {
            if (!allowLobbyAttempt(socket)) {
                issueError(socket, "Too many lobby attempts. Try again in a minute.");
                return;
            }
            if (rooms.size >= MAX_ROOMS) {
                issueError(socket, "The lobby service is full. Try again later.");
                return;
            }
            const name = normalizeName(message.name);
            if (!name) {
                issueError(socket, `Enter a name of 1-${MAX_NAME_LENGTH} characters.`);
                return;
            }
            const code = makeRoomCode(rooms);
            const token = randomToken();
            const player = {
                id: randomToken(9),
                name,
                token,
                socket,
                ready: false,
                role: null,
                challenge: null,
                challengeComplete: false
            };
            const room = {
                code,
                hostToken: token,
                phase: "lobby",
                players: new Map([[player.id, player]]),
                settings: {
                    imposterCount: 1,
                    challengeAssignment: "random",
                    enabledChallenges: [...DEFAULT_CHALLENGES]
                },
                votes: new Map(),
                results: null
            };
            rooms.set(code, room);
            socketPlayers.set(socket, { code, id: player.id });
            send(socket, { type: "joined", token, playerId: player.id });
            sendRoom(room);
            return;
        }

        if (message.type === "join") {
            if (!allowLobbyAttempt(socket)) {
                issueError(socket, "Too many lobby attempts. Try again in a minute.");
                return;
            }
            const code = typeof message.code === "string" ? message.code.trim().toUpperCase() : "";
            const name = normalizeName(message.name);
            const room = rooms.get(code);
            if (!room) {
                issueError(socket, "That lobby code was not found.");
                return;
            }
            if (!name) {
                issueError(socket, `Enter a name of 1-${MAX_NAME_LENGTH} characters.`);
                return;
            }
            if (room.phase !== "lobby") {
                issueError(socket, "This round has already started.");
                return;
            }
            if (room.players.size >= MAX_PLAYERS) {
                issueError(socket, "This lobby is full.");
                return;
            }
            const token = randomToken();
            const player = {
                id: randomToken(9),
                name,
                token,
                socket,
                ready: false,
                role: null,
                challenge: null,
                challengeComplete: false
            };
            room.players.set(player.id, player);
            socketPlayers.set(socket, { code, id: player.id });
            send(socket, { type: "joined", token, playerId: player.id });
            sendRoom(room);
            return;
        }

        if (message.type === "resume" && typeof message.token === "string") {
            for (const room of rooms.values()) {
                const player = [...room.players.values()].find((candidate) =>
                    candidate.token === message.token
                );
                if (!player) {
                    continue;
                }
                if (player.socket !== socket) {
                    socketPlayers.delete(player.socket);
                    player.socket.close(4001, "Session resumed elsewhere");
                }
                player.socket = socket;
                socketPlayers.set(socket, { code: room.code, id: player.id });
                send(socket, { type: "joined", token: player.token, playerId: player.id });
                sendRoom(room);
                return;
            }
            issueError(socket, "This lobby session has expired.");
            return;
        }

        const identity = getPlayer(socket);
        if (!identity) {
            issueError(socket, "Create or join a lobby first.");
            return;
        }
        const { room, player } = identity;
        if (message.type === "leave") {
            socketPlayers.delete(socket);
            removePlayer(room, player);
            socket.close(1000, "Left lobby");
        } else if (message.type === "ready") {
            if (room.phase !== "lobby" || typeof message.ready !== "boolean") {
                issueError(socket, "Ready status cannot be changed now.");
                return;
            }
            player.ready = message.ready;
            sendRoom(room);
            startRound(room);
        } else if (message.type === "challenge-complete") {
            if (room.phase !== "playing" || player.role !== "imposter") {
                issueError(socket, "Only an imposter can mark a challenge complete.");
                return;
            }
            player.challengeComplete = message.complete === true;
            sendRoom(room);
        } else if (message.type === "game-stats") {
            if (room.phase !== "playing" || player.role !== "imposter" ||
                normalizeName(message.playerName)?.toLowerCase() !== player.name.toLowerCase()) {
                return;
            }
            const ownGoals = Number(message.ownGoals);
            const demos = Number(message.demos);
            const goals = Number(message.goals);
            const completed =
                (player.challenge === "own_goal" && ownGoals > 0) ||
                (player.challenge === "three_demos" && demos >= 3) ||
                (player.challenge === "no_goals" &&
                    message.matchEnded === true && goals === 0);
            if (completed && !player.challengeComplete) {
                player.challengeComplete = true;
                sendRoom(room);
            }
        } else if (message.type === "settings") {
            if (player.token !== room.hostToken || room.phase !== "lobby") {
                issueError(socket, "Only the host can change lobby settings.");
                return;
            }
            const enabled = Array.isArray(message.enabledChallenges)
                ? [...new Set(message.enabledChallenges.filter((id) =>
                    DEFAULT_CHALLENGES.includes(id)
                ))]
                : room.settings.enabledChallenges;
            if (enabled.length === 0) {
                issueError(socket, "Enable at least one challenge.");
                return;
            }
            const count = Number(message.imposterCount);
            if (!Number.isInteger(count) || count < 1 || count > room.players.size) {
                issueError(socket, "Imposter count must be between 1 and the player count.");
                return;
            }
            const assignment = message.challengeAssignment;
            if (assignment !== "random" && assignment !== "same") {
                issueError(socket, "Choose same or random challenge assignment.");
                return;
            }
            room.settings = {
                imposterCount: count,
                challengeAssignment: assignment,
                enabledChallenges: enabled
            };
            for (const roomPlayer of room.players.values()) {
                roomPlayer.ready = false;
            }
            sendRoom(room);
        } else if (message.type === "match-ended") {
            if (room.phase !== "playing") {
                issueError(socket, "Voting can only start after a round begins.");
                return;
            }
            room.phase = "voting";
            room.votes.clear();
            sendRoom(room);
        } else if (message.type === "vote") {
            if (room.phase !== "voting" || room.votes.has(player.id)) {
                issueError(socket, "Your vote cannot be changed now.");
                return;
            }
            const selected = [...new Set(Array.isArray(message.suspects)
                ? message.suspects.filter((id) =>
                    typeof id === "string" && room.players.has(id) && id !== player.id
                )
                : [])];
            if ((room.settings.imposterCount === 1 && selected.length !== 1) ||
                (room.settings.imposterCount > 1 && selected.length === 0)) {
                issueError(socket, room.settings.imposterCount === 1
                    ? "Select exactly one other player."
                    : "Select at least one other player.");
                return;
            }
            room.votes.set(player.id, selected);
            if (room.votes.size === room.players.size) {
                finishVoting(room);
            } else {
                sendRoom(room);
            }
        } else if (message.type === "end-voting") {
            if (player.token !== room.hostToken) {
                issueError(socket, "Only the host can end voting.");
                return;
            }
            finishVoting(room);
        } else if (message.type === "next-round") {
            if (player.token !== room.hostToken || room.phase !== "results") {
                issueError(socket, "Only the host can start another round.");
                return;
            }
            room.phase = "lobby";
            room.votes.clear();
            room.results = null;
            for (const roomPlayer of room.players.values()) {
                roomPlayer.ready = false;
                roomPlayer.role = null;
                roomPlayer.challenge = null;
                roomPlayer.challengeComplete = false;
            }
            sendRoom(room);
        } else {
            issueError(socket, "Unknown lobby action.");
        }
    }

    webSocketServer.on("connection", (socket, request) => {
        socket.clientAddress = request.socket.remoteAddress;
        socket.on("message", (message) => handleMessage(socket, message));
        socket.on("close", () => {
            const identity = getPlayer(socket);
            if (identity) {
                socketPlayers.delete(socket);
                removePlayer(identity.room, identity.player);
            }
        });
        socket.on("error", (error) => {
            console.error("Imposter lobby WebSocket error:", error.message);
        });
    });

    return {
        rooms,
        httpServer,
        webSocketServer,
        listen() {
            return new Promise((resolve, reject) => {
                httpServer.once("error", reject);
                httpServer.listen(port, host, () => {
                    httpServer.removeListener("error", reject);
                    resolve(httpServer.address());
                });
            });
        },
        close() {
            return new Promise((resolve, reject) => {
                webSocketServer.close((webSocketError) => {
                    httpServer.close((httpError) => {
                        const error = webSocketError || httpError;
                        if (error) {
                            reject(error);
                        } else {
                            resolve();
                        }
                    });
                });
            });
        }
    };
}

if (require.main === module) {
    const server = createImposterServer();
    server.listen().then(({ address, port }) => {
        console.log(`Imposter lobby server listening on ${address}:${port}`);
    }).catch((error) => {
        console.error("Could not start imposter lobby server:", error);
        process.exitCode = 1;
    });
}

module.exports = {
    createImposterServer,
    MAX_PLAYERS
};
