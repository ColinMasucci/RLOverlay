const fs = require("fs");
const path = require("path");

const DEFAULT_PACKET_SEND_RATE = 10;
const MIN_PACKET_SEND_RATE = 1;
const MAX_PACKET_SEND_RATE = 120;
const API_SECTION = "TAGame.MatchStatsExporter_TA";

function getConfigPaths(configDirectory) {
    return {
        directory: configDirectory,
        taStats: path.join(configDirectory, "TAStatsAPI.ini"),
        defaultStats: path.join(configDirectory, "DefaultStatsAPI.ini")
    };
}

function isFile(filePath) {
    try {
        return fs.statSync(filePath).isFile();
    } catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

function readIni(filePath) {
    const buffer = fs.readFileSync(filePath);
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
        return {
            text: buffer.subarray(2).toString("utf16le"),
            encoding: "utf16le",
            hasBom: true
        };
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
        throw new Error(`${filePath} uses UTF-16BE encoding, which cannot be safely edited automatically.`);
    }

    const text = buffer.toString("utf8");
    const hasBom = text.startsWith("\uFEFF");
    return {
        text: hasBom ? text.slice(1) : text,
        encoding: "utf8",
        hasBom
    };
}

function encodeIni(text, encoding, hasBom) {
    const content = Buffer.from(text, encoding);
    if (!hasBom) {
        return content;
    }
    const bom = encoding === "utf16le"
        ? Buffer.from([0xff, 0xfe])
        : Buffer.from([0xef, 0xbb, 0xbf]);
    return Buffer.concat([bom, content]);
}

function getSectionRange(lines) {
    const start = lines.findIndex((line) => {
        const section = /^\s*\[([^\]]+)\]\s*(?:;.*)?$/.exec(line);
        return section?.[1].trim().toLowerCase() === API_SECTION.toLowerCase();
    });
    if (start < 0) {
        return null;
    }
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
        if (/^\s*\[[^\]]+\]/.test(lines[index])) {
            end = index;
            break;
        }
    }
    return { start, end };
}

function parseRate(text, filePath) {
    const lines = text.split(/\r\n|\n|\r/);
    const section = getSectionRange(lines);
    if (!section) {
        return null;
    }
    for (let index = section.start + 1; index < section.end; index += 1) {
        const entry = /^\s*PacketSendRate\s*=\s*([^;]*?)(?:\s*;.*)?$/i.exec(lines[index]);
        if (entry) {
            const rate = Number(entry[1].trim());
            if (!Number.isInteger(rate) ||
                rate < MIN_PACKET_SEND_RATE ||
                rate > MAX_PACKET_SEND_RATE) {
                throw new Error(
                    `${filePath} has an invalid PacketSendRate. Set it to a whole number from ` +
                    `${MIN_PACKET_SEND_RATE} to ${MAX_PACKET_SEND_RATE}.`
                );
            }
            return rate;
        }
    }
    return null;
}

function createDefaultIni(rate) {
    return [
        `[${API_SECTION}]`,
        "Port=49123",
        "WebPort=49124",
        `PacketSendRate=${rate}`,
        "",
        "[IniVersion]",
        "0=1785886389.000000",
        ""
    ].join("\n");
}

function upsertRate(text, rate) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r\n|\n|\r/);
    const section = getSectionRange(lines);
    if (!section) {
        if (text.length > 0 && !/[\r\n]$/.test(text)) {
            lines.push("");
        }
        lines.push(`[${API_SECTION}]`, `PacketSendRate=${rate}`);
        return lines.join(newline);
    }

    for (let index = section.start + 1; index < section.end; index += 1) {
        const entry = /^(\s*PacketSendRate\s*=\s*)[^;\r\n]*?(\s*;.*)?$/i.exec(lines[index]);
        if (entry) {
            lines[index] = `${entry[1]}${rate}${entry[2] ?? ""}`;
            return lines.join(newline);
        }
    }
    lines.splice(section.start + 1, 0, `PacketSendRate=${rate}`);
    return lines.join(newline);
}

function writeIni(filePath, text, encoding, hasBom) {
    const backupPath = `${filePath}.RLOverlay.bak`;
    if (isFile(filePath) && !isFile(backupPath)) {
        fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    }

    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, encodeIni(text, encoding, hasBom), { flag: "wx" });
        fs.renameSync(temporaryPath, filePath);
    } catch (error) {
        try {
            fs.unlinkSync(temporaryPath);
        } catch (cleanupError) {
            if (cleanupError.code !== "ENOENT") {
                console.error("Could not remove temporary Rocket League config file:", cleanupError.message);
            }
        }
        throw error;
    }
}

function selectConfigFile(configDirectory) {
    const paths = getConfigPaths(configDirectory);
    if (isFile(paths.taStats)) {
        return paths.taStats;
    }
    if (isFile(paths.defaultStats)) {
        return paths.defaultStats;
    }
    return paths.defaultStats;
}

function ensureStatsApiConfig(configDirectory) {
    const paths = getConfigPaths(configDirectory);
    fs.mkdirSync(paths.directory, { recursive: true });
    const filePath = selectConfigFile(configDirectory);
    if (!isFile(filePath)) {
        writeIni(filePath, createDefaultIni(DEFAULT_PACKET_SEND_RATE), "utf8", false);
        return { filePath, rate: DEFAULT_PACKET_SEND_RATE, created: true };
    }

    const ini = readIni(filePath);
    const currentRate = parseRate(ini.text, filePath);
    const rate = currentRate ?? DEFAULT_PACKET_SEND_RATE;
    if (currentRate === null) {
        writeIni(filePath, upsertRate(ini.text, rate), ini.encoding, ini.hasBom);
    }
    return { filePath, rate, created: false };
}

function setStatsApiPacketRate(configDirectory, rate) {
    if (!Number.isInteger(rate) ||
        rate < MIN_PACKET_SEND_RATE ||
        rate > MAX_PACKET_SEND_RATE) {
        throw new Error(
            `Packet send rate must be a whole number from ${MIN_PACKET_SEND_RATE} to ` +
            `${MAX_PACKET_SEND_RATE}.`
        );
    }

    const paths = getConfigPaths(configDirectory);
    fs.mkdirSync(paths.directory, { recursive: true });
    const filePath = selectConfigFile(configDirectory);
    if (!isFile(filePath)) {
        writeIni(filePath, createDefaultIni(rate), "utf8", false);
        return { filePath, rate, created: true };
    }

    const ini = readIni(filePath);
    writeIni(filePath, upsertRate(ini.text, rate), ini.encoding, ini.hasBom);
    return { filePath, rate, created: false };
}

module.exports = {
    DEFAULT_PACKET_SEND_RATE,
    MAX_PACKET_SEND_RATE,
    MIN_PACKET_SEND_RATE,
    ensureStatsApiConfig,
    setStatsApiPacketRate
};
