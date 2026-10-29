const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const matchHistory = require("./match-history");
const matchEvents = require("./match-events");

let overlayWindow;
let statusWindow;
let settingsWindow;
let trackerWindow;
let rocketLeagueSocket;
let trackerLookupGeneration = 0;

let players = [];
let currentMatchGuid = null;
let lastEndedMatchGuid = null;
let matchHasState = false;
let matchHasEnded = false;
let archivedMatchIds = new Set();
let savedMatches = [];
let overlayView = "scoreboard";
let playerOptionsSignature = "";
let matchHistoryError = null;
const trackerRankLookups = new Set();
const trackerRankByPlayer = new Map();
let trackerRankLookupQueue = Promise.resolve();
let matchEpochNumber = 0;
const kickoffState = matchEvents.createKickoffState();
const previousBoostByPlayer = new Map();
const boostCollectedByPlayer = new Map();
const postHitsByPlayer = new Map();
const aerialHitsByPlayer = new Map();
const kickoffWinsByPlayer = new Map();
const kickoffAttemptsByPlayer = new Map();
const ownGoalsByPlayer = new Map();
const latestBallHitByTeam = new Map();
let latestBallTouch = null;
let previousTeamGoals = null;
let boostCollectionPaused = false;
const kickoffDuels = [];
const playerMotionByKey = new Map();
const kickoffBoostPendingPlayers = new Set();
const heatmapSamples = [];
let kickoffBoostPendingNewPlayers = false;
let isVisible = false;
let connectionEnabled = true;
let connectionStatus = {
    connected: false,
    receiving: false
};
const defaultSettings = {
    keyboard: {
        toggleOverlay: "F8",
        toggleConnection: "F9",
        toggleSettings: "F10",
        toggleHistory: "F11"
    },
    gamepad: {
        overlayButton: 8,
        toggleConnectionButton: null
    },
    overlayScale: 1.15,
    positionX: 0,
    positionYOffset: 110,
    trackedPlayerId: null,
    showStatusWindow: true,
    showHeatmap: true,
    heatmapMode: "overall",
    enableRankLookup: true,
    statVisibility: {
        score: true,
        goals: true,
        assists: true,
        saves: true,
        shots: true,
        demos: true,
        touches: true,
        carTouches: true,
        postHits: true,
        boostCollected: true,
        aerialHits: true,
        kickoffWins: true,
        ownGoals: true
    }
};
const statKeys = Object.keys(defaultSettings.statVisibility);
const OVERLAY_BASE_WIDTH = 1400;
const OVERLAY_BASE_HEIGHT = 800;
let settings = structuredClone(defaultSettings);
let gamepadBindingTarget = null;
const heldOverlayButtons = new Set();
const heldConnectionButtons = new Set();

function settingsFilePath() {
    return path.join(app.getPath("userData"), "settings.json");
}

function matchHistoryFilePath() {
    return path.join(app.getPath("userData"), "match-history.json");
}

function loadMatchHistory() {
    try {
        const data = JSON.parse(fs.readFileSync(matchHistoryFilePath(), "utf8"));
        if (!data || data.version !== 1 || !Array.isArray(data.matches)) {
            throw new Error("Match history file has an unsupported format.");
        }
        data.matches = data.matches.map((match) => ({
            ...match,
            kickoffDuels: match.kickoffDuels ?? [],
            players: Array.isArray(match.players)
                ? match.players.map((player) => ({
                    ...player,
                    stats: {
                        ...player.stats,
                        kickoffWins: player.stats?.kickoffWins ?? 0,
                        kickoffAttempts: player.stats?.kickoffAttempts ?? 0,
                        ownGoals: player.stats?.ownGoals ?? 0
                    }
                }))
                : match.players
        }));
        if (data.matches.some((match) =>
            !match || typeof match.id !== "string" ||
            typeof match.finishedAt !== "string" ||
            !Number.isFinite(Date.parse(match.finishedAt)) ||
            !Array.isArray(match.teamGoals) || match.teamGoals.length !== 2 ||
            !match.teamGoals.every(Number.isFinite) ||
            !Array.isArray(match.players) ||
            match.players.some((player) =>
                !player || typeof player.id !== "string" ||
                typeof player.name !== "string" ||
                (player.team !== 0 && player.team !== 1) ||
                !player.stats || typeof player.stats !== "object" ||
                matchHistory.statFields.some((field) =>
                    !Number.isFinite(player.stats[field])
                )
            )
        )) {
            throw new Error("Match history file contains invalid match records.");
        }
        savedMatches = data.matches;
        archivedMatchIds = new Set(savedMatches.map((match) => match.id));
    } catch (error) {
        if (error.code === "ENOENT") {
            return;
        }
        console.error("Could not load match history:", error.message);
        matchHistoryError = error.message;
        savedMatches = [];
        archivedMatchIds.clear();
    }
}

function saveMatchHistoryFile() {
    const filePath = matchHistoryFilePath();
    const temporaryPath = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
        temporaryPath,
        `${JSON.stringify({ version: 1, matches: savedMatches }, null, 2)}\n`,
        "utf8"
    );
    fs.renameSync(temporaryPath, filePath);
}

function sendMatchHistoryUpdated(force = false) {
    const playerOptions = matchHistory.listPlayerOptions(savedMatches, players);
    const activeRoster = players
        .filter((player) => player.active !== false)
        .map((player) => ({ id: player.id, team: player.team }));
    const signature = JSON.stringify({ playerOptions, activeRoster });
    if (!force && signature === playerOptionsSignature) {
        return;
    }
    playerOptionsSignature = signature;
    const payload = {
        summary: matchHistory.aggregateMatches(
            savedMatches,
            settings.trackedPlayerId,
            players
        ),
        totalMatches: savedMatches.length,
        playerOptions,
        trackedPlayerId: settings.trackedPlayerId,
        error: matchHistoryError
    };
    for (const window of [overlayWindow, settingsWindow]) {
        if (window && !window.isDestroyed()) {
            window.webContents.send("match-history-updated", payload);
        }
    }
}

function archiveCurrentMatch(matchId, finalPlayers = players) {
    const fallbackId = matchId || `local-${Date.now()}-${savedMatches.length}`;
    const normalizedId = String(fallbackId);
    if (archivedMatchIds.has(normalizedId)) {
        return false;
    }

    const record = matchHistory.createMatchRecord(normalizedId, finalPlayers, undefined, kickoffDuels);
    if (!record) {
        return false;
    }

    savedMatches.push(record);
    try {
        saveMatchHistoryFile();
    } catch (error) {
        savedMatches.pop();
        matchHistoryError = `Could not save match history: ${error.message}`;
        console.error("Could not save completed match history:", error.message);
        sendMatchHistoryUpdated(true);
        return false;
    }
    archivedMatchIds.add(normalizedId);
    matchHistoryError = null;
    sendMatchHistoryUpdated(true);
    console.log(`Saved completed match ${normalizedId} to local history.`);
    return true;
}

function validateSettings(value) {
    if (!value || typeof value !== "object" ||
        !value.keyboard || typeof value.keyboard !== "object" ||
        !value.gamepad || typeof value.gamepad !== "object") {
        throw new Error("Settings must include keyboard and gamepad bindings.");
    }

    const {
        toggleOverlay,
        toggleConnection,
        toggleSettings = defaultSettings.keyboard.toggleSettings,
        toggleHistory = defaultSettings.keyboard.toggleHistory
    } = value.keyboard;
    if (typeof toggleOverlay !== "string" || !toggleOverlay.trim() ||
        typeof toggleConnection !== "string" || !toggleConnection.trim() ||
        typeof toggleSettings !== "string" || !toggleSettings.trim() ||
        typeof toggleHistory !== "string" || !toggleHistory.trim()) {
        throw new Error("Keyboard shortcuts cannot be empty.");
    }

    const shortcuts = [toggleOverlay, toggleConnection, toggleSettings, toggleHistory]
        .map((shortcut) => shortcut.trim().toLowerCase());
    if (new Set(shortcuts).size !== shortcuts.length) {
        throw new Error("Keyboard shortcuts must be different.");
    }

    const validButton = (button) => button === null ||
        (Number.isInteger(button) && button >= 0 && button <= 31);

    if (!validButton(value.gamepad.overlayButton) ||
        !validButton(value.gamepad.toggleConnectionButton)) {
        throw new Error("Controller button numbers must be between 0 and 31.");
    }

    if (value.gamepad.overlayButton !== null &&
        value.gamepad.overlayButton === value.gamepad.toggleConnectionButton) {
        throw new Error("Overlay and connection must use different controller buttons.");
    }

    const overlayScale = value.overlayScale ?? defaultSettings.overlayScale;
    const positionX = value.positionX ?? defaultSettings.positionX;
    const legacyPositionY = value.positionY;
    const legacyPositionYPercent = value.positionYPercent;
    const positionYOffset = value.positionYOffset ??
        (Number.isInteger(legacyPositionY)
            ? Math.max(-500, Math.min(500, legacyPositionY))
            : Number.isFinite(legacyPositionYPercent)
                ? Math.round((legacyPositionYPercent - 50) * 2)
                : defaultSettings.positionYOffset);
    const showStatusWindow = value.showStatusWindow ?? defaultSettings.showStatusWindow;
    const showHeatmap = value.showHeatmap ?? defaultSettings.showHeatmap;
    const heatmapMode = value.heatmapMode ?? defaultSettings.heatmapMode;
    const enableRankLookup = value.enableRankLookup ?? defaultSettings.enableRankLookup;
    const trackedPlayerId = value.trackedPlayerId ?? null;
    const statVisibility = value.statVisibility ?? defaultSettings.statVisibility;
    if (typeof overlayScale !== "number" || !Number.isFinite(overlayScale) ||
        overlayScale < 0.8 || overlayScale > 1.5) {
        throw new Error("Overlay size must be between 80% and 150%.");
    }
    if (!Number.isInteger(positionX) || positionX < -1000 || positionX > 1000 ||
        !Number.isInteger(positionYOffset) || positionYOffset < -500 ||
        positionYOffset > 500) {
        throw new Error("Vertical position offset must be between -500 and 500 pixels.");
    }
    if (typeof showStatusWindow !== "boolean") {
        throw new Error("Status window visibility must be enabled or disabled.");
    }
    if (typeof showHeatmap !== "boolean") {
        throw new Error("Heatmap visibility must be enabled or disabled.");
    }
    if (heatmapMode !== "overall" && heatmapMode !== "zones") {
        throw new Error("Heatmap mode must be overall or three-zone.");
    }
    if (typeof enableRankLookup !== "boolean") {
        throw new Error("Tracker Network rank lookup must be enabled or disabled.");
    }
    if (trackedPlayerId !== null &&
        (typeof trackedPlayerId !== "string" || !trackedPlayerId.trim())) {
        throw new Error("Tracked player must be selected from the player list.");
    }
    if (!statVisibility || typeof statVisibility !== "object" ||
        statKeys.some((key) => typeof (statVisibility[key] ?? true) !== "boolean")) {
        throw new Error("Each stat visibility option must be enabled or disabled.");
    }

    return {
        keyboard: {
            toggleOverlay: toggleOverlay.trim(),
            toggleConnection: toggleConnection.trim(),
            toggleSettings: toggleSettings.trim(),
            toggleHistory: toggleHistory.trim()
        },
        gamepad: {
            overlayButton: value.gamepad.overlayButton,
            toggleConnectionButton: value.gamepad.toggleConnectionButton
        },
        overlayScale,
        positionX,
        positionYOffset,
        trackedPlayerId,
        showStatusWindow,
        showHeatmap,
        heatmapMode,
        enableRankLookup,
        statVisibility: Object.fromEntries(
            statKeys.map((key) => [key, statVisibility[key] ?? true])
        )
    };
}

function loadSettings() {
    try {
        settings = validateSettings(JSON.parse(fs.readFileSync(settingsFilePath(), "utf8")));
    } catch (error) {
        if (error.code === "ENOENT") {
            return;
        }

        console.error("Could not load settings; using defaults:", error.message);
        settings = structuredClone(defaultSettings);
    }
}

function saveSettingsFile(nextSettings) {
    const filePath = settingsFilePath();
    const temporaryPath = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, filePath);
}

function sendSettingsUpdated() {
    for (const window of [overlayWindow, statusWindow, settingsWindow]) {
        if (window && !window.isDestroyed()) {
            window.webContents.send("settings-updated", settings);
        }
    }
}

function registerKeyboardShortcuts(nextSettings) {
    globalShortcut.unregisterAll();

    try {
        const overlayRegistered = globalShortcut.register(
            nextSettings.keyboard.toggleOverlay,
            toggleOverlay
        );
        const connectionRegistered = globalShortcut.register(
            nextSettings.keyboard.toggleConnection,
            () => setApiConnectionEnabled(!connectionEnabled)
        );
        const settingsRegistered = globalShortcut.register(
            nextSettings.keyboard.toggleSettings,
            toggleSettingsWindow
        );
        const historyRegistered = globalShortcut.register(
            nextSettings.keyboard.toggleHistory,
            toggleOverlayView
        );

        if (!overlayRegistered || !connectionRegistered || !settingsRegistered ||
            !historyRegistered) {
            globalShortcut.unregisterAll();
            return false;
        }

        return true;
    } catch (error) {
        globalShortcut.unregisterAll();
        console.error("Could not register configured keyboard shortcuts:", error.message);
        return false;
    }
}

function publishGamepadBindingResult(result) {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send("gamepad-binding-result", result);
    }
}

function getPlayerKey(player) {
    const team = Number.isInteger(player.TeamNum) ? player.TeamNum : "unknown";
    const shortcut = Number.isInteger(player.Shortcut) ? player.Shortcut : "unknown";
    return `${team}|${shortcut}|${player.Name ?? ""}`;
}

function getPlayerStatKey(player) {
    const team = player.TeamNum ?? player.team;
    const shortcut = player.Shortcut ?? player.shortcut;
    const name = player.Name ?? player.name;
    const rosterPlayer = players.find((candidate) =>
        (team === undefined || candidate.team === team) &&
        ((Number.isInteger(shortcut) && candidate.shortcut === shortcut) ||
            (typeof name === "string" && candidate.name === name))
    );
    return rosterPlayer
        ? getPlayerKey({
            TeamNum: rosterPlayer.team,
            Shortcut: rosterPlayer.shortcut,
            Name: rosterPlayer.name
        })
        : getPlayerKey({
            TeamNum: team,
            Shortcut: shortcut,
            Name: name
        });
}

function getHasFlip(player) {
    const value = player.bHasFlip ?? player.HasFlip ?? player.hasFlip;
    return typeof value === "boolean" ? value : undefined;
}

function isAerialHit(motion) {
    if (motion?.onGround !== false || motion.onWall !== false) {
        return false;
    }
    if (motion.hasFlip === false) {
        return true;
    }

    // The Stats API does not expose flip availability; use the standard ground-jump dodge window as a fallback.
    return motion.hasFlip === undefined &&
        Number.isFinite(motion.airborneSince) &&
        Date.now() - motion.airborneSince >= 1250;
}

function getRosterPlayerKey(player) {
    const primaryId = typeof player.PrimaryId === "string"
        ? player.PrimaryId
        : player.id;
    if (typeof primaryId === "string" && primaryId.trim()) {
        const idParts = primaryId.split("|");
        if (idParts[0]?.trim() && idParts[1]?.trim() &&
            Number(idParts[1].trim()) !== 0) {
            return `id:${primaryId.trim().toLowerCase()}`;
        }
    }

    const team = Number.isInteger(player.TeamNum) ? player.TeamNum : player.team ?? "unknown";
    const name = player.Name ?? player.name ?? "";
    return `name:${team}|${String(name).trim().toLowerCase()}`;
}

function sendPlayersUpdated() {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("players-updated", players);
    }
}

function resetMatchStats(matchGuid) {
    currentMatchGuid = matchGuid;
    matchHasState = false;
    matchHasEnded = false;
    matchEpochNumber += 1;
    trackerRankLookups.clear();
    trackerRankByPlayer.clear();
    previousBoostByPlayer.clear();
    boostCollectedByPlayer.clear();
    postHitsByPlayer.clear();
    aerialHitsByPlayer.clear();
    kickoffWinsByPlayer.clear();
    kickoffAttemptsByPlayer.clear();
    ownGoalsByPlayer.clear();
    kickoffDuels.length = 0;
    playerMotionByKey.clear();
    latestBallHitByTeam.clear();
    latestBallTouch = null;
    previousTeamGoals = null;
    boostCollectionPaused = false;
    if (matchGuid) {
        matchEvents.startKickoff(kickoffState);
    } else {
        kickoffState.active = false;
        kickoffState.lastTouchByTeam.clear();
    }
    kickoffBoostPendingPlayers.clear();
    heatmapSamples.length = 0;
    kickoffBoostPendingNewPlayers = false;
    players = [];
    sendHeatmapUpdated();
    sendPlayersUpdated();
}

function sendHeatmapUpdated() {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("heatmap-updated", heatmapSamples);
    }
}

function recordHeatmapSample(location, player) {
    if (!currentMatchGuid || !location ||
        !Number.isFinite(location.X) || !Number.isFinite(location.Y) ||
        !player || (player.TeamNum !== 0 && player.TeamNum !== 1)) {
        return;
    }

    heatmapSamples.push({
        x: Math.max(-4096, Math.min(4096, location.X)),
        y: Math.max(-5120, Math.min(5120, location.Y)),
        team: player.TeamNum,
        player: player.Name ?? "Unknown"
    });
    if (heatmapSamples.length > 3000) {
        heatmapSamples.splice(0, heatmapSamples.length - 3000);
    }
    sendHeatmapUpdated();
}

function getTrackerProfileUrl(player) {
    const platform = typeof player.id === "string"
        ? player.id.split("|", 1)[0].trim().toLowerCase()
        : "";
    if ((platform !== "epic" && platform !== "steam") ||
        typeof player.name !== "string" || !player.name.trim()) {
        return null;
    }

    return `https://rocketleague.tracker.network/rocket-league/profile/${platform}/${encodeURIComponent(player.name.trim())}/mmr?playlist=11`;
}

function getTrackerBrowserWindow() {
    if (trackerWindow && !trackerWindow.isDestroyed()) {
        return trackerWindow;
    }

    trackerWindow = new BrowserWindow({
        show: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });
    trackerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    trackerWindow.on("closed", () => {
        trackerWindow = null;
    });
    return trackerWindow;
}

async function scrapeTrackerRank(profileUrl) {
    const window = getTrackerBrowserWindow();
    await window.loadURL(profileUrl);
    return window.webContents.executeJavaScript(`(() => new Promise((resolve) => {
        let attempts = 0;
        const readRank = () => {
            const widget = document.querySelector(".peak-rating-widget .peak-rating");
            const mmr = widget?.querySelector(".numbers span.value")?.textContent?.trim();
            const rankImage = widget?.querySelector("img[alt]");
            const rank = rankImage?.getAttribute("alt")?.trim();
            const logo = rankImage?.currentSrc || rankImage?.getAttribute("src");
            if (mmr && rank) {
                resolve({ mmr, rank, logo });
                return;
            }
            attempts += 1;
            if (attempts >= 20) {
                resolve(null);
                return;
            }
            setTimeout(readRank, 500);
        };
        readRank();
    }))()`);
}

async function lookupTrackerRanks(matchEpoch) {
    if (!settings.enableRankLookup) {
        return;
    }
    const lookupGeneration = trackerLookupGeneration;
    const pendingPlayers = players.filter((player) => {
        if (player.active === false) {
            return false;
        }
        const profileUrl = getTrackerProfileUrl(player);
        const key = getPlayerKey({
            TeamNum: player.team,
            Shortcut: player.shortcut,
            Name: player.name
        });
        if (!profileUrl || trackerRankLookups.has(key) || trackerRankByPlayer.has(key)) {
            return false;
        }
        trackerRankLookups.add(key);
        return true;
    });

    for (const player of pendingPlayers) {
        if (matchEpoch !== matchEpochNumber || !settings.enableRankLookup ||
            lookupGeneration !== trackerLookupGeneration) {
            return;
        }
        const profileUrl = getTrackerProfileUrl(player);
        const key = getPlayerKey({
            TeamNum: player.team,
            Shortcut: player.shortcut,
            Name: player.name
        });
        try {
            const rank = await scrapeTrackerRank(profileUrl);
            if (matchEpoch !== matchEpochNumber || !settings.enableRankLookup ||
                lookupGeneration !== trackerLookupGeneration) {
                return;
            }
            if (!rank) {
                console.warn(`Tracker Network did not return rank data for ${player.name}.`);
                continue;
            }
            if (typeof rank.logo !== "string" ||
                !rank.logo.startsWith("https://trackercdn.com/")) {
                rank.logo = null;
            }
            const currentPlayer = players.find((candidate) =>
                getPlayerKey({
                    TeamNum: candidate.team,
                    Shortcut: candidate.shortcut,
                    Name: candidate.name
                }) === key
            );
            if (currentPlayer) {
                trackerRankByPlayer.set(key, rank);
                currentPlayer.trackerRank = rank;
                sendPlayersUpdated();
            }
        } catch (error) {
            if (!settings.enableRankLookup ||
                lookupGeneration !== trackerLookupGeneration) {
                trackerRankLookups.delete(key);
                return;
            }
            console.error(`Could not load Tracker Network rank for ${player.name}:`, error.message);
        }
    }
}

function queueTrackerRankLookup(matchEpoch) {
    trackerRankLookupQueue = trackerRankLookupQueue
        .then(() => lookupTrackerRanks(matchEpoch))
        .catch((error) => {
            console.error("Could not complete Tracker Network rank lookups:", error.message);
        });
}

function positionOverlay() {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
        return;
    }

    const { workArea } = screen.getPrimaryDisplay();
    const [width, height] = overlayWindow.getSize();
    const x = Math.round(workArea.x + (workArea.width - width) / 2 + settings.positionX);
    const y = Math.round(workArea.y + (workArea.height - height) / 2 + settings.positionYOffset);
    overlayWindow.setPosition(
        Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, x)),
        y
    );
}

function applyOverlayScale() {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
        return;
    }

    const scale = settings.overlayScale;
    overlayWindow.setSize(
        Math.round(OVERLAY_BASE_WIDTH * scale),
        Math.round(OVERLAY_BASE_HEIGHT * scale)
    );
    if (overlayWindow.webContents.isLoading()) {
        overlayWindow.webContents.once("did-finish-load", () => {
            if (!overlayWindow.isDestroyed()) {
                overlayWindow.webContents.setZoomFactor(scale);
                positionOverlay();
            }
        });
    } else {
        overlayWindow.webContents.setZoomFactor(scale);
        positionOverlay();
    }
}

function createOverlay() {
    const scale = settings.overlayScale;
    const { workArea } = screen.getPrimaryDisplay();
    const width = Math.round(OVERLAY_BASE_WIDTH * scale);
    const height = Math.round(OVERLAY_BASE_HEIGHT * scale);
    overlayWindow = new BrowserWindow({
        width,
        height,
        x: Math.round(workArea.x + (workArea.width - width) / 2 + settings.positionX),
        y: Math.round(
            workArea.y + (workArea.height - height) / 2 + settings.positionYOffset
        ),
        show: false,

        frame: false,
        transparent: true,
        backgroundColor: "#00000000",

        alwaysOnTop: true,
        focusable: false,
        skipTaskbar:true,

        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    overlayWindow.setIgnoreMouseEvents(true);
    overlayWindow.setAlwaysOnTop(true, "screen-saver");
    overlayWindow.on("show", () => {
        positionOverlay();
        overlayWindow.setAlwaysOnTop(true, "screen-saver");
        overlayWindow.moveTop();
    });

    overlayWindow.loadFile(path.join(__dirname, "dist", "index.html"));
    overlayWindow.webContents.on("did-finish-load", () => {
        overlayWindow.webContents.setZoomFactor(settings.overlayScale);
        positionOverlay();
        overlayWindow.webContents.send("settings-updated", settings);
        overlayWindow.webContents.send("overlay-view-updated", overlayView);
        sendHeatmapUpdated();
        sendMatchHistoryUpdated(true);
    });
}

function createStatusWindow() {
    const { workArea } = screen.getPrimaryDisplay();

    statusWindow = new BrowserWindow({
        width: 440,
        height: 100,
        x: workArea.x + workArea.width - 460,
        y: workArea.y + 20,
        show: settings.showStatusWindow,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        hasShadow: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false
        }
    });

    const keepStatusWindowOnTop = () => {
        if (!statusWindow || statusWindow.isDestroyed()) {
            return;
        }

        statusWindow.setAlwaysOnTop(true, "screen-saver");
        statusWindow.moveTop();
    };

    statusWindow.on("show", keepStatusWindowOnTop);
    statusWindow.on("focus", keepStatusWindowOnTop);
    keepStatusWindowOnTop();
    statusWindow.loadFile(path.join(__dirname, "dist", "status.html"));
    statusWindow.webContents.on("did-finish-load", () => {
        publishConnectionStatus();
        sendSettingsUpdated();
    });
}

function toggleSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        if (settingsWindow.isVisible()) {
            settingsWindow.hide();
        } else {
            settingsWindow.show();
            settingsWindow.focus();
        }
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 560,
        height: 800,
        show: false,
        resizable: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    settingsWindow.on("close", () => {
        gamepadBindingTarget = null;
        heldOverlayButtons.clear();
        setOverlayVisible(false);
    });
    settingsWindow.on("closed", () => {
        settingsWindow = null;
    });
    settingsWindow.webContents.on("did-finish-load", () => {
        settingsWindow.webContents.send("settings-updated", settings);
        settingsWindow.webContents.send("settings-file-path", settingsFilePath());
        settingsWindow.webContents.send("match-history-file-path", matchHistoryFilePath());
        sendMatchHistoryUpdated(true);
    });

    settingsWindow.loadFile(path.join(__dirname, "dist", "settings.html"));
    settingsWindow.show();
}

function toggleOverlayView() {
    overlayView = overlayView === "scoreboard" ? "history" : "scoreboard";
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("overlay-view-updated", overlayView);
    }
}

function saveSettings(nextValue) {
    let nextSettings;

    try {
        nextSettings = validateSettings(nextValue);
    } catch (error) {
        return { ok: false, error: error.message };
    }

    if (!registerKeyboardShortcuts(nextSettings)) {
        registerKeyboardShortcuts(settings);
        return {
            ok: false,
            error: "Could not register those shortcuts. They may be invalid or already in use."
        };
    }

    try {
        saveSettingsFile(nextSettings);
    } catch (error) {
        registerKeyboardShortcuts(settings);
        console.error("Could not save settings file:", error.message);
        return { ok: false, error: `Could not save settings: ${error.message}` };
    }

    const previousSettings = settings;
    settings = nextSettings;
    if (previousSettings.enableRankLookup && !settings.enableRankLookup) {
        trackerLookupGeneration += 1;
        trackerRankLookups.clear();
        trackerRankByPlayer.clear();
        players = players.map((player) => ({ ...player, trackerRank: null }));
        sendPlayersUpdated();
        if (trackerWindow && !trackerWindow.isDestroyed()) {
            trackerWindow.webContents.stop();
        }
    } else if (!previousSettings.enableRankLookup && settings.enableRankLookup) {
        queueTrackerRankLookup(matchEpochNumber);
    }
    if (previousSettings.gamepad.overlayButton !== settings.gamepad.overlayButton) {
        heldOverlayButtons.clear();
        setOverlayVisible(false);
    }
    if (previousSettings.gamepad.toggleConnectionButton !==
        settings.gamepad.toggleConnectionButton) {
        heldConnectionButtons.clear();
    }
    if (previousSettings.overlayScale !== settings.overlayScale) {
        applyOverlayScale();
    }
    if (previousSettings.positionX !== settings.positionX ||
        previousSettings.positionYOffset !== settings.positionYOffset) {
        positionOverlay();
    }
    if (previousSettings.showStatusWindow !== settings.showStatusWindow &&
        statusWindow && !statusWindow.isDestroyed()) {
        if (settings.showStatusWindow) {
            statusWindow.show();
        } else {
            statusWindow.hide();
        }
    }
    if (previousSettings.showHeatmap !== settings.showHeatmap) {
        sendPlayersUpdated();
    }
    sendSettingsUpdated();
    sendMatchHistoryUpdated(true);
    return { ok: true };
}

function startGamepadBinding(target) {
    if (target !== "overlayButton" && target !== "toggleConnectionButton") {
        return;
    }

    gamepadBindingTarget = target;
    heldOverlayButtons.clear();
    heldConnectionButtons.clear();
    setOverlayVisible(false);
    publishGamepadBindingResult({ target, message: "Press a controller button..." });
}

function handleGamepadButtonChange(event, data) {
    if (!statusWindow || event.sender.id !== statusWindow.webContents.id ||
        !data || typeof data.controllerId !== "string" ||
        !Number.isInteger(data.button) || data.button < 0 || data.button > 31 ||
        typeof data.pressed !== "boolean") {
        return;
    }

    const buttonId = `${data.controllerId}:${data.button}`;

    if (data.pressed && gamepadBindingTarget) {
        const target = gamepadBindingTarget;
        gamepadBindingTarget = null;
        const updated = {
            ...settings,
            gamepad: {
                ...settings.gamepad,
                [target]: data.button
            }
        };
        const result = saveSettings(updated);

        if (!result.ok) {
            publishGamepadBindingResult({ target, message: result.error, error: true });
            return;
        }

        publishGamepadBindingResult({
            target,
            message: `Bound to controller button ${data.button}.`
        });
        return;
    }

    if (gamepadBindingTarget) {
        return;
    }

    if (settings.gamepad.overlayButton === data.button) {
        if (data.pressed) {
            heldOverlayButtons.add(buttonId);
        } else {
            heldOverlayButtons.delete(buttonId);
        }
        setOverlayVisible(heldOverlayButtons.size > 0);
    }

    if (settings.gamepad.toggleConnectionButton === data.button) {
        if (data.pressed && !heldConnectionButtons.has(buttonId)) {
            setApiConnectionEnabled(!connectionEnabled);
        }

        if (data.pressed) {
            heldConnectionButtons.add(buttonId);
        } else {
            heldConnectionButtons.delete(buttonId);
        }
    }
}

function publishConnectionStatus() {
    if (statusWindow && !statusWindow.isDestroyed()) {
        statusWindow.webContents.send("connection-status-updated", {
            ...connectionStatus,
            enabled: connectionEnabled
        });
    }
}

function connectToRocketLeague() {
    if (!connectionEnabled || (rocketLeagueSocket &&
        (rocketLeagueSocket.readyState === WebSocket.OPEN ||
            rocketLeagueSocket.readyState === WebSocket.CONNECTING))) {
        return;
    }

    const address = "ws://127.0.0.1:49124";

    rocketLeagueSocket = new WebSocket(address);
    const socket = rocketLeagueSocket;

    socket.on("open", () => {
        if (rocketLeagueSocket !== socket) {
            socket.close();
            return;
        }

        console.log("Connected to Rocket League Stats API!");
        connectionStatus = { connected: true, receiving: false };
        publishConnectionStatus();
    });

    socket.on("message", (rawMessage) => {
        if (rocketLeagueSocket !== socket) {
            return;
        }

        connectionStatus.receiving = true;
        publishConnectionStatus();

        try {
            // Parse the outer message.
            const message = JSON.parse(rawMessage.toString());

            // Rocket League sends Data as a JSON string, so parse it too.
            const data = typeof message.Data === "string"
                ? JSON.parse(message.Data)
                : message.Data;

            if (data?.MatchGuid && currentMatchGuid &&
                data.MatchGuid !== currentMatchGuid) {
                if (matchHasState) {
                    archiveCurrentMatch(currentMatchGuid, players);
                }
                resetMatchStats(data.MatchGuid);
            } else if (data?.MatchGuid && !currentMatchGuid) {
                if (data.MatchGuid !== lastEndedMatchGuid) {
                    resetMatchStats(data.MatchGuid);
                    lastEndedMatchGuid = null;
                }
            }

            if (matchHasEnded &&
                (!data?.MatchGuid || data.MatchGuid === lastEndedMatchGuid)) {
                return;
            }

            if (["Goal", "GoalScored", "GoalScoredEvent"].includes(message.Event)) {
                boostCollectionPaused = true;
            }

            if (["MatchEnded", "MatchFinished", "GameEnded"].includes(message.Event)) {
                if (matchHasState) {
                    archiveCurrentMatch(currentMatchGuid, players);
                }
                if (currentMatchGuid) {
                    lastEndedMatchGuid = currentMatchGuid;
                }
                currentMatchGuid = null;
                matchHasState = false;
                matchHasEnded = true;
                kickoffState.active = false;
                kickoffState.lastTouchByTeam.clear();
                boostCollectionPaused = true;
                kickoffBoostPendingPlayers.clear();
                kickoffBoostPendingNewPlayers = false;
                sendPlayersUpdated();
            } else if (message.Event === "RoundStarted") {
                matchEvents.startKickoff(kickoffState);
                boostCollectionPaused = false;
                kickoffBoostPendingPlayers.clear();
                kickoffBoostPendingNewPlayers = true;
            } else if (message.Event === "BallHit") {
                for (const toucher of data?.Players ?? []) {
                    if ((toucher.TeamNum === 0 || toucher.TeamNum === 1) && toucher.Name) {
                        latestBallTouch = toucher;
                        latestBallHitByTeam.set(toucher.TeamNum, toucher);
                        recordHeatmapSample(data?.Ball?.Location, toucher);

                        const key = getPlayerStatKey(toucher);
                        const motion = playerMotionByKey.get(key);
                        if (isAerialHit(motion)) {
                            aerialHitsByPlayer.set(key, (aerialHitsByPlayer.get(key) ?? 0) + 1);
                        }
                    }
                }
                recordKickoffResult(matchEvents.registerKickoffBallHit(
                    kickoffState,
                    data?.Players,
                    data?.Ball?.Location
                ));
                if (data?.Players?.length) {
                    players = players.map((player) => {
                        const key = getPlayerKey({
                            TeamNum: player.team,
                            Shortcut: player.shortcut,
                            Name: player.name
                        });
                        return {
                            ...player,
                            aerialHits: aerialHitsByPlayer.get(key) ?? 0
                        };
                    });
                    sendPlayersUpdated();
                }
            } else if (message.Event === "CrossbarHit") {
                const lastTouchPlayer = data?.BallLastTouch?.Player;
                const heatmapPlayer = lastTouchPlayer &&
                    latestBallHitByTeam.get(lastTouchPlayer.TeamNum);
                if (heatmapPlayer) {
                    recordHeatmapSample(data?.BallLocation, heatmapPlayer);
                }
                if ((lastTouchPlayer?.TeamNum === 0 || lastTouchPlayer?.TeamNum === 1) &&
                    lastTouchPlayer.Name) {
                    const creditedPlayer = latestBallHitByTeam.get(1 - lastTouchPlayer.TeamNum);
                    if (!creditedPlayer) {
                        return;
                    }

                    const key = getPlayerKey(creditedPlayer);
                    postHitsByPlayer.set(key, (postHitsByPlayer.get(key) ?? 0) + 1);

                    const matchingPlayer = players.find((player) =>
                        player.name === creditedPlayer.Name &&
                        player.team === creditedPlayer.TeamNum &&
                        (creditedPlayer.Shortcut === undefined ||
                            player.shortcut === creditedPlayer.Shortcut)
                    );
                    if (matchingPlayer) {
                        matchingPlayer.postHits = postHitsByPlayer.get(key);
                    }
                    sendPlayersUpdated();
                }
            } else if (message.Event === "UpdateState") {
                const matchPlayers = data?.Players ?? [];
                const teamGoals = matchEvents.getTeamGoalTotals(matchPlayers);
                if (previousTeamGoals === null) {
                    previousTeamGoals = teamGoals;
                } else {
                    let goalScored = false;
                    for (const scoringTeam of [0, 1]) {
                        const goalsScored = teamGoals[scoringTeam] - previousTeamGoals[scoringTeam];
                        if (goalsScored <= 0) {
                            continue;
                        }

                        goalScored = true;
                        boostCollectionPaused = true;
                        if (goalsScored > 1) {
                            console.warn(
                                "Skipped own-goal attribution because multiple goals arrived between state updates."
                            );
                        } else {
                            recordKickoffResult(matchEvents.resolveKickoffGoal(
                                kickoffState,
                                scoringTeam,
                                matchPlayers
                            ));
                            if (latestBallTouch?.TeamNum === 1 - scoringTeam) {
                                const key = getPlayerKey(latestBallTouch);
                                ownGoalsByPlayer.set(
                                    key,
                                    (ownGoalsByPlayer.get(key) ?? 0) + goalsScored
                                );
                            }
                        }
                    }
                    previousTeamGoals = teamGoals;
                    if (goalScored) {
                        latestBallTouch = null;
                        kickoffState.active = false;
                        kickoffState.lastTouchByTeam.clear();
                    }
                }

                const previousPlayersByKey = new Map(players.map((player) => [
                    getRosterPlayerKey(player),
                    player
                ]));
                const uniqueMatchPlayers = [...new Map(matchPlayers.map((player) => [
                    getRosterPlayerKey(player),
                    player
                ])).values()];
                const currentPlayerKeys = new Set();
                const updatedPlayers = uniqueMatchPlayers.map((player) => {
                    const key = getPlayerKey(player);
                    const rosterKey = getRosterPlayerKey(player);
                    currentPlayerKeys.add(rosterKey);
                    const previousMotion = playerMotionByKey.get(key);
                    const inAir = player.bOnGround === false && player.bOnWall === false;
                    playerMotionByKey.set(key, {
                        onGround: player.bOnGround,
                        onWall: player.bOnWall,
                        hasFlip: getHasFlip(player),
                        airborneSince: inAir
                            ? previousMotion?.onGround === false &&
                                previousMotion?.onWall === false
                                ? previousMotion.airborneSince
                                : Date.now()
                            : null
                    });
                    const boost = player.Boost;
                    const previousBoost = previousBoostByPlayer.get(key);

                    if (kickoffBoostPendingNewPlayers) {
                        kickoffBoostPendingPlayers.add(key);
                    }

                    if (Number.isFinite(boost)) {
                        if (!Number.isFinite(previousBoost)) {
                            kickoffBoostPendingPlayers.delete(key);
                        } else if (boost > previousBoost && !boostCollectionPaused) {
                            if (kickoffBoostPendingPlayers.has(key)) {
                                kickoffBoostPendingPlayers.delete(key);
                            } else {
                                boostCollectedByPlayer.set(
                                    key,
                                    (boostCollectedByPlayer.get(key) ?? 0) + boost - previousBoost
                                );
                            }
                        }
                        previousBoostByPlayer.set(key, boost);
                    }

                    return {
                        name: player.Name,
                        team: player.TeamNum,
                        shortcut: player.Shortcut,
                        id: player.PrimaryId,
                        score: player.Score,
                        goals: player.Goals,
                        shots: player.Shots,
                        assists: player.Assists,
                        saves: player.Saves,
                        carTouches: player.CarTouches,
                        touches: player.Touches,
                        demos: player.Demos,
                        postHits: postHitsByPlayer.get(key) ?? 0,
                        boostCollected: boostCollectedByPlayer.get(key) ?? 0,
                        aerialHits: aerialHitsByPlayer.get(key) ?? 0,
                        kickoffWins: kickoffWinsByPlayer.get(key) ?? 0,
                        kickoffAttempts: kickoffAttemptsByPlayer.get(key) ?? 0,
                        ownGoals: ownGoalsByPlayer.get(key) ?? 0,
                        trackerRank: trackerRankByPlayer.get(key) ??
                            previousPlayersByKey.get(rosterKey)?.trackerRank ?? null,
                        active: true
                    };
                });
                const newPlayersJoined = updatedPlayers.some((player) =>
                    !previousPlayersByKey.has(getRosterPlayerKey(player))
                );
                const departedPlayers = [...previousPlayersByKey.entries()]
                    .filter(([key]) => !currentPlayerKeys.has(key))
                    .map(([, player]) => player)
                    .map((player) => ({ ...player, active: false }));
                players = [...updatedPlayers, ...departedPlayers];
                matchHasState = players.length > 0;
                kickoffBoostPendingNewPlayers = false;

                console.log("Current players:", players);

                // Send the updated player list to the overlay.
                sendPlayersUpdated();
                sendMatchHistoryUpdated();
                if (newPlayersJoined) {
                    queueTrackerRankLookup(matchEpochNumber);
                }
            }
        } catch (error) {
            console.error("Could not parse game message:", error);
        }
    });


    socket.on("error", (error) => {
        console.error("Rocket League connection error:", error.message);
    });

    socket.on("close", () => {
        if (rocketLeagueSocket !== socket) {
            return;
        }

        rocketLeagueSocket = null;
        console.log("Rocket League connection closed.");
        connectionStatus = { connected: false, receiving: false };
        publishConnectionStatus();
    });
}

function disconnectFromRocketLeague() {
    if (!rocketLeagueSocket) {
        connectionStatus = { connected: false, receiving: false };
        publishConnectionStatus();
        return;
    }

    const socket = rocketLeagueSocket;
    rocketLeagueSocket = null;
    connectionStatus = { connected: false, receiving: false };
    publishConnectionStatus();

    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close();
    }
}

function setApiConnectionEnabled(enabled) {
    connectionEnabled = enabled;

    if (connectionEnabled) {
        connectToRocketLeague();
    } else {
        disconnectFromRocketLeague();
    }

    publishConnectionStatus();
}

function getMatchPlayerId(player) {
    if (typeof player.PrimaryId === "string" && player.PrimaryId.trim()) {
        return player.PrimaryId.trim();
    }
    return `name:${player.Name.trim().toLowerCase()}`;
}

function recordKickoffResult(result) {
    if (!result) {
        return;
    }

    for (const participant of result.participants) {
        const key = getPlayerKey(participant.player);
        kickoffAttemptsByPlayer.set(key, (kickoffAttemptsByPlayer.get(key) ?? 0) + 1);
    }

    if (result.winner) {
        const winnerKey = getPlayerKey(result.winner);
        kickoffWinsByPlayer.set(winnerKey, (kickoffWinsByPlayer.get(winnerKey) ?? 0) + 1);
    }

    const blueToucher = result.participants.find((participant) => participant.team === 0)?.player;
    const orangeToucher = result.participants.find((participant) => participant.team === 1)?.player;
    if (blueToucher && orangeToucher) {
        const winnerId = result.winner ? getMatchPlayerId(result.winner) : null;
        const blueId = getMatchPlayerId(blueToucher);
        const orangeId = getMatchPlayerId(orangeToucher);
        if (blueId !== orangeId) {
            kickoffDuels.push({
                bluePlayerId: blueId,
                orangePlayerId: orangeId,
                winnerId
            });
        }
    }
}

function setOverlayVisible(visible) {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
        return;
    }

    isVisible = visible;

    if (isVisible) {
        // Send the most recent data when opening the overlay.
        overlayWindow.webContents.send("players-updated", players);
        overlayWindow.webContents.send("overlay-view-updated", overlayView);
        sendMatchHistoryUpdated(true);

        overlayWindow.show();
        overlayWindow.setAlwaysOnTop(true, "screen-saver");
        overlayWindow.moveTop();
    } else {
        overlayWindow.hide();
    }
}

function toggleOverlay() {
    setOverlayVisible(!isVisible);
}

app.whenReady().then(() => {
    loadSettings();
    loadMatchHistory();
    if (!registerKeyboardShortcuts(settings)) {
        console.error("Could not register saved shortcuts; reverting to defaults.");
        settings = structuredClone(defaultSettings);
        registerKeyboardShortcuts(settings);
    }

    createOverlay();
    createStatusWindow();
    connectToRocketLeague();

    ipcMain.on("set-api-connection", (_event, enabled) => {
        setApiConnectionEnabled(enabled === true);
    });

    ipcMain.on("toggle-settings-window", (event) => {
        if (statusWindow && event.sender.id === statusWindow.webContents.id) {
            toggleSettingsWindow();
        }
    });

    ipcMain.handle("get-settings", (event) => {
        if (!settingsWindow || event.sender.id !== settingsWindow.webContents.id) {
            throw new Error("Settings are only available to the settings window.");
        }
        return {
            settings,
            filePath: settingsFilePath(),
            historyFilePath: matchHistoryFilePath(),
            playerOptions: matchHistory.listPlayerOptions(savedMatches, players)
        };
    });

    ipcMain.handle("save-settings", (event, value) => {
        if (!settingsWindow || event.sender.id !== settingsWindow.webContents.id) {
            throw new Error("Only the settings window can update settings.");
        }
        return saveSettings(value);
    });

    ipcMain.on("start-gamepad-binding", (event, target) => {
        if (settingsWindow && event.sender.id === settingsWindow.webContents.id) {
            startGamepadBinding(target);
        }
    });

    ipcMain.on("cancel-gamepad-binding", (event) => {
        if (settingsWindow && event.sender.id === settingsWindow.webContents.id) {
            gamepadBindingTarget = null;
        }
    });

    ipcMain.on("gamepad-button-change", handleGamepadButtonChange);
});

app.on("will-quit", () => {
    globalShortcut.unregisterAll();

    if (rocketLeagueSocket) {
        disconnectFromRocketLeague();
    }
    if (trackerWindow && !trackerWindow.isDestroyed()) {
        trackerWindow.destroy();
    }
});