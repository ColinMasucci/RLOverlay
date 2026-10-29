import React from "react";

export function getPlatform(playerId) {
    const parts = typeof playerId === "string" ? playerId.split("|") : [];
    if (parts[1]?.trim() === "0" || parts[1]?.trim() === "1") {
        return "Bot";
    }

    const platform = parts[0]?.trim().toLowerCase();
    return platform === "steam"
        ? "Steam"
        : platform === "epic"
            ? "Epic"
            : "Unknown";
}

export default function PlatformIcon({ platform }) {
    if (platform === "Steam") {
        return (
            <svg className="platform-icon" viewBox="0 0 24 24" role="img" aria-label="Steam">
                <circle cx="12" cy="12" r="11" fill="#171a21" />
                <path d="M7 16l5-3 3-5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
                <circle cx="16" cy="7" r="3.5" fill="none" stroke="#fff" strokeWidth="1.8" />
                <circle cx="6.5" cy="17" r="2.5" fill="none" stroke="#fff" strokeWidth="1.8" />
            </svg>
        );
    }
    if (platform === "Epic") {
        return (
            <svg className="platform-icon" viewBox="0 0 24 24" role="img" aria-label="Epic">
                <rect x="1" y="2" width="22" height="20" rx="3" fill="#fff" />
                <text x="12" y="15" textAnchor="middle" fontSize="8" fontWeight="900" fill="#191919">
                    EPIC
                </text>
            </svg>
        );
    }
    if (platform === "Bot") {
        return (
            <svg className="platform-icon" viewBox="0 0 24 24" role="img" aria-label="Bot">
                <rect x="4" y="7" width="16" height="13" rx="3" fill="#667085" stroke="#fff" strokeWidth="1.5" />
                <path d="M12 7V4" stroke="#fff" strokeWidth="1.5" />
                <circle cx="12" cy="3" r="1.5" fill="#45d483" />
                <path d="M8 12h.01M16 12h.01" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
                <path d="M9 16h6" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
        );
    }
    return (
        <svg className="platform-icon" viewBox="0 0 24 24" role="img" aria-label="Unknown">
            <text x="12" y="20" textAnchor="middle" fontSize="21" fontWeight="bold" fill="#aab8d0">
                ?
            </text>
        </svg>
    );
}
