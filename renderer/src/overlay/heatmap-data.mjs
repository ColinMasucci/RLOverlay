export function getZoneTouchShares(samples, userTeam) {
    const counts = [0, 0, 0];
    for (const sample of samples) {
        if (sample.isTouch !== true) {
            continue;
        }
        const y = userTeam === 1 ? -sample.y : sample.y;
        const zone = y > 5120 / 3 ? 0 : y < -5120 / 3 ? 2 : 1;
        counts[zone] += 1;
    }
    const total = counts.reduce((sum, count) => sum + count, 0);
    return counts.map((count) => total ? count / total * 100 : null);
}
