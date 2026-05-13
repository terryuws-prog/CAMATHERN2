export function startWaterFlow(canvas) {
  const context = canvas.getContext("2d");
  const streams = Array.from({ length: 8 }, (_, index) => ({
    y: 90 + index * 72,
    speed: 0.18 + index * 0.03,
    amplitude: 18 + index * 3,
    phase: index * 0.9,
  }));

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * ratio;
    canvas.height = window.innerHeight * ratio;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function draw(frame) {
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    context.lineCap = "round";

    streams.forEach((stream, index) => {
      context.beginPath();
      for (let x = -80; x <= window.innerWidth + 80; x += 18) {
        const wave = Math.sin((x * 0.012) + stream.phase + frame * stream.speed * 0.01);
        const y = stream.y + wave * stream.amplitude + Math.sin(frame * 0.004 + index) * 8;
        if (x === -80) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.strokeStyle = index % 2 === 0 ? "rgba(18, 118, 142, 0.10)" : "rgba(44, 157, 125, 0.10)";
      context.lineWidth = index % 2 === 0 ? 2.4 : 1.5;
      context.stroke();
    });

    requestAnimationFrame(draw);
  }

  resize();
  window.addEventListener("resize", resize);
  requestAnimationFrame(draw);
}
