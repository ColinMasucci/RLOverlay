import React, { useEffect, useRef } from "react";

function getPossession(samples) {
    const counts = [0, 0];
    for (const sample of samples) {
        if (sample.team === 0 || sample.team === 1) counts[sample.team] += 1;
    }
    const total = counts[0] + counts[1];
    return total ? [counts[0] / total * 100, counts[1] / total * 100] : null;
}

function drawHeatmap(canvas, samples, mode) {
    const context = canvas.getContext("2d");
    const { width, height } = canvas;
    const field = { left: 52, right: width - 52, top: 54, bottom: height - 54 };
    const fieldWidth = field.right - field.left;
    const fieldHeight = field.bottom - field.top;
    const centerX = (field.left + field.right) / 2;
    const middleY = (field.top + field.bottom) / 2;
    const cornerCut = 44;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#111b2a";
    context.fillRect(0, 0, width, height);

    const traceField = () => {
        context.beginPath();
        context.moveTo(field.left + cornerCut, field.top);
        context.lineTo(field.right - cornerCut, field.top);
        context.quadraticCurveTo(field.right, field.top, field.right, field.top + cornerCut);
        context.lineTo(field.right, field.bottom - cornerCut);
        context.quadraticCurveTo(field.right, field.bottom, field.right - cornerCut, field.bottom);
        context.lineTo(field.left + cornerCut, field.bottom);
        context.quadraticCurveTo(field.left, field.bottom, field.left, field.bottom - cornerCut);
        context.lineTo(field.left, field.top + cornerCut);
        context.quadraticCurveTo(field.left, field.top, field.left + cornerCut, field.top);
        context.closePath();
    };

    const drawGoal = (direction) => {
        const goalWidth = fieldWidth * 0.28;
        const goalDepth = 42;
        const goalLeft = centerX - goalWidth / 2;
        const goalTop = direction < 0 ? field.top - goalDepth : field.bottom;
        const goalY = direction < 0 ? field.top : field.bottom;
        context.fillStyle = "rgba(8, 15, 25, 0.9)";
        context.fillRect(goalLeft, goalTop, goalWidth, goalDepth);
        context.strokeStyle = "rgba(242, 249, 255, 0.82)";
        context.lineWidth = 3;
        context.strokeRect(goalLeft, goalTop, goalWidth, goalDepth);
        context.save();
        context.beginPath();
        context.rect(goalLeft + 3, goalTop + 3, goalWidth - 6, goalDepth - 6);
        context.clip();
        context.strokeStyle = "rgba(225, 239, 247, 0.28)";
        context.lineWidth = 1;
        for (let x = goalLeft; x <= goalLeft + goalWidth; x += 12) {
            context.beginPath();
            context.moveTo(x, goalTop);
            context.lineTo(x, goalTop + goalDepth);
            context.stroke();
        }
        for (let y = goalTop; y <= goalTop + goalDepth; y += 10) {
            context.beginPath();
            context.moveTo(goalLeft, y);
            context.lineTo(goalLeft + goalWidth, y);
            context.stroke();
        }
        context.restore();
        context.strokeStyle = "rgba(242, 249, 255, 0.78)";
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(centerX - goalWidth / 2, goalY);
        context.lineTo(centerX - goalWidth / 2, goalY + direction * 80);
        context.lineTo(centerX + goalWidth / 2, goalY + direction * 80);
        context.lineTo(centerX + goalWidth / 2, goalY);
        context.stroke();
    };

    context.save();
    traceField();
    context.clip();
    const grass = context.createLinearGradient(0, field.top, 0, field.bottom);
    grass.addColorStop(0, "#244f54");
    grass.addColorStop(0.5, "#28604f");
    grass.addColorStop(1, "#244f54");
    context.fillStyle = grass;
    context.fillRect(field.left, field.top, fieldWidth, fieldHeight);
    for (let stripe = 0; stripe < 12; stripe += 1) {
        if (stripe % 2 === 0) {
            context.fillStyle = "rgba(210, 255, 232, 0.035)";
            context.fillRect(field.left, field.top + stripe * fieldHeight / 12, fieldWidth, fieldHeight / 12);
        }
    }

    const zonePossessions = [];
    if (mode === "zones") {
        const zones = [
            samples.filter((sample) => sample.y > 5120 / 3),
            samples.filter((sample) => sample.y <= 5120 / 3 && sample.y >= -5120 / 3),
            samples.filter((sample) => sample.y < -5120 / 3)
        ];
        for (let index = 0; index < zones.length; index += 1) {
            const possession = getPossession(zones[index]);
            zonePossessions.push(possession);
            const zoneTop = field.top + index * fieldHeight / 3;
            if (!possession || possession[0] === possession[1]) {
                context.fillStyle = possession
                    ? "rgba(141, 153, 167, 0.35)"
                    : "rgba(141, 153, 167, 0.24)";
            } else {
                const leading = possession[0] > possession[1] ? 0 : 1;
                const share = Math.max(...possession);
                const opacity = 0.12 + (share - 50) / 50 * 0.88;
                const color = leading === 0 ? "53, 167, 255" : "255, 155, 69";
                context.fillStyle = `rgba(${color}, ${opacity})`;
            }
            context.fillRect(field.left, zoneTop, fieldWidth, fieldHeight / 3);
        }
    } else {
        context.fillStyle = "rgba(53, 167, 255, 0.12)";
        context.fillRect(field.left, field.top, fieldWidth, fieldHeight / 2);
        context.fillStyle = "rgba(255, 155, 69, 0.12)";
        context.fillRect(field.left, middleY, fieldWidth, fieldHeight / 2);
        for (const sample of samples) {
            const x = field.left + ((sample.x + 4096) / 8192) * fieldWidth;
            const y = field.top + ((5120 - sample.y) / 10240) * fieldHeight;
            const color = sample.team === 0 ? "53, 167, 255" : "255, 155, 69";
            const radius = 52;
            const gradient = context.createRadialGradient(x, y, 2, x, y, radius);
            gradient.addColorStop(0, `rgba(${color}, 0.5)`);
            gradient.addColorStop(0.45, `rgba(${color}, 0.22)`);
            gradient.addColorStop(1, `rgba(${color}, 0)`);
            context.fillStyle = gradient;
            context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
        }
    }

    context.strokeStyle = "rgba(231, 247, 239, 0.76)";
    context.lineWidth = mode === "zones" ? 3 : 2;
    context.beginPath();
    if (mode === "zones") {
        context.setLineDash([8, 8]);
        context.moveTo(field.left, field.top + fieldHeight / 3);
        context.lineTo(field.right, field.top + fieldHeight / 3);
        context.moveTo(field.left, field.top + fieldHeight * 2 / 3);
        context.lineTo(field.right, field.top + fieldHeight * 2 / 3);
        context.setLineDash([]);
    } else {
        context.moveTo(field.left, middleY);
        context.lineTo(field.right, middleY);
    }
    context.moveTo(centerX, field.top);
    context.lineTo(centerX, field.bottom);
    context.stroke();
    if (mode === "zones") {
        context.save();
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.font = "bold 60px Arial";
        zonePossessions.forEach((possession, index) => {
            const [blue, orange] = possession ?? [0, 0];
            const centerY = field.top + (index + 0.5) * fieldHeight / 3;
            context.fillStyle = "#8fcfff";
            context.shadowColor = "#35a7ff";
            context.shadowBlur = 18;
            context.fillText(`${Math.round(blue)}%`, field.left + fieldWidth / 4, centerY, fieldWidth / 2 - 20);
            context.fillStyle = "#ffc18b";
            context.shadowColor = "#ff9b45";
            context.fillText(`${Math.round(orange)}%`, field.left + fieldWidth * 3 / 4, centerY, fieldWidth / 2 - 20);
        });
        context.restore();
    }
    context.beginPath();
    context.arc(centerX, middleY, 76, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.arc(centerX, middleY, 7, 0, Math.PI * 2);
    context.fillStyle = "rgba(238, 248, 241, 0.9)";
    context.fill();
    const boxWidth = fieldWidth * 0.58;
    context.beginPath();
    context.rect(centerX - boxWidth / 2, field.top, boxWidth, 118);
    context.rect(centerX - boxWidth / 2, field.bottom - 118, boxWidth, 118);
    context.stroke();
    const goalAreaWidth = fieldWidth * 0.34;
    context.beginPath();
    context.rect(centerX - goalAreaWidth / 2, field.top, goalAreaWidth, 48);
    context.rect(centerX - goalAreaWidth / 2, field.bottom - 48, goalAreaWidth, 48);
    context.stroke();
    for (const spotY of [field.top + 82, field.bottom - 82]) {
        context.beginPath();
        context.arc(centerX, spotY, 30, 0, Math.PI * 2);
        context.stroke();
        context.beginPath();
        context.arc(centerX, spotY, 5, 0, Math.PI * 2);
        context.fillStyle = "rgba(245, 250, 245, 0.9)";
        context.fill();
    }
    traceField();
    context.strokeStyle = "rgba(231, 247, 239, 0.92)";
    context.lineWidth = 4;
    context.stroke();
    context.restore();
    drawGoal(-1);
    drawGoal(1);
    if (mode !== "zones" && samples.length) {
        const latest = samples[samples.length - 1];
        const x = field.left + ((latest.x + 4096) / 8192) * fieldWidth;
        const y = field.top + ((5120 - latest.y) / 10240) * fieldHeight;
        context.beginPath();
        context.arc(x, y, 8, 0, Math.PI * 2);
        context.fillStyle = latest.team === 0 ? "#35a7ff" : "#ff9b45";
        context.fill();
        context.lineWidth = 3;
        context.strokeStyle = "#fff";
        context.stroke();
    }
}

export default function Heatmap({ samples, mode }) {
    const canvasRef = useRef(null);
    const possession = getPossession(samples);
    useEffect(() => {
        if (canvasRef.current) drawHeatmap(canvasRef.current, samples, mode);
    }, [samples, mode]);

    return (
        <aside className="heatmap-panel" aria-label="Ball location heatmap">
            <h2>Ball Heatmap</h2>
            <div className="possession-header" aria-label="Overall possession by team">
                <span className="possession-total blue-possession-total">
                    {Math.round(possession?.[0] ?? 0)}%
                </span>
                <span className="possession-title">
                    <span className="possession-dot blue-dot" />
                    <span>POSSESSION</span>
                    <span className="possession-dot orange-dot" />
                </span>
                <span className="possession-total orange-possession-total">
                    {Math.round(possession?.[1] ?? 0)}%
                </span>
            </div>
            <canvas
                ref={canvasRef}
                className="heatmap-canvas"
                width="640"
                height="800"
                aria-label="Top-down map showing ball locations or three-zone team possession"
            />
        </aside>
    );
}
