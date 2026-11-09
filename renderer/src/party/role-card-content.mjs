export function getRoleCardContent({
    role,
    settings,
    challengeLabel,
    speedTarget,
    speedHint,
    roleHidden
}) {
    const isImposter = role === "imposter" && !roleHidden;
    let task;
    if (settings.gameMode === "speed") {
        if (role === "imposter" && !roleHidden) {
            task = "Blend in and work out the safe players’ target speed.";
            if (speedHint) {
                task += ` Hint: the shared target is between ${speedHint.min} and ${speedHint.max} ${settings.speedUnit.toUpperCase()}.`;
            }
        } else {
            task = `Try to score a goal at ${speedTarget} ${settings.speedUnit.toUpperCase()}. Let your team know how it went.`;
            if (role === "imposter" && speedHint) {
                task += ` Hint: the shared target is between ${speedHint.min} and ${speedHint.max} ${settings.speedUnit.toUpperCase()}.`;
            }
        }
    } else if (role === "imposter") {
        task = `Your task: ${challengeLabel}.`;
    } else {
        task = "There is an imposter among you. Guess who they are and their task.";
    }

    return {
        label: isImposter ? "IMPOSTER" : "SAFE",
        task,
        isSafe: !isImposter
    };
}
