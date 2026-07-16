import * as THREE from "./vendor/three.module.min.js";

const canvas = document.getElementById("bg-canvas");
if (!canvas) {
  // nothing to render into
} else {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isSmallScreen = window.innerWidth < 720;
  const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;

  if (prefersReducedMotion || (isSmallScreen && isCoarsePointer)) {
    canvas.remove();
  } else {
    try {
      initScene(canvas);
    } catch (err) {
      // WebGL can be unavailable or disabled (old browser, remote/virtual
      // display, low-power mode) — fail quietly rather than break the page.
      console.warn("Port Checker: background animation disabled —", err.message);
      canvas.remove();
    }
  }
}

function initScene(canvas) {
  // Rendering at a lower internal resolution than the CSS size (and letting
  // the GPU upscale) cuts fragment-shader work substantially for an ambient,
  // already-blurred-looking background — the softness costs nothing visually
  // here but saves real GPU time, which matters on the low-power/remote
  // clients this dashboard is often viewed from.
  const RENDER_SCALE = 0.6;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.z = 22;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
  renderer.setSize(window.innerWidth * RENDER_SCALE, window.innerHeight * RENDER_SCALE, false);

  const COUNT = window.innerWidth < 1100 ? 45 : 80;
  const SPREAD = 26;
  const positions = new Float32Array(COUNT * 3);
  const velocities = [];

  for (let i = 0; i < COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * SPREAD * 2;
    positions[i * 3 + 1] = (Math.random() - 0.5) * SPREAD;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 14;
    velocities.push({
      x: (Math.random() - 0.5) * 0.006,
      y: (Math.random() - 0.5) * 0.006,
      z: (Math.random() - 0.5) * 0.003,
    });
  }

  const pointsGeometry = new THREE.BufferGeometry();
  pointsGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const pointsMaterial = new THREE.PointsMaterial({
    color: 0x8fb3ff,
    size: 0.16,
    transparent: true,
    opacity: 0.85,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(pointsGeometry, pointsMaterial);
  scene.add(points);

  const maxLines = COUNT * 6;
  const linePositions = new Float32Array(maxLines * 2 * 3);
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0x5b8cff,
    transparent: true,
    opacity: 0.12,
  });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  scene.add(lines);

  const LINK_DIST = 6.5;

  let mouseX = 0;
  let mouseY = 0;
  window.addEventListener("mousemove", (e) => {
    mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  function updateLines() {
    let idx = 0;
    for (let i = 0; i < COUNT; i++) {
      if (idx >= maxLines) break;
      for (let j = i + 1; j < COUNT; j++) {
        if (idx >= maxLines) break;
        const dx = positions[i * 3] - positions[j * 3];
        const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
        const dz = positions[i * 3 + 2] - positions[j * 3 + 2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < LINK_DIST) {
          linePositions[idx * 6] = positions[i * 3];
          linePositions[idx * 6 + 1] = positions[i * 3 + 1];
          linePositions[idx * 6 + 2] = positions[i * 3 + 2];
          linePositions[idx * 6 + 3] = positions[j * 3];
          linePositions[idx * 6 + 4] = positions[j * 3 + 1];
          linePositions[idx * 6 + 5] = positions[j * 3 + 2];
          idx++;
        }
      }
    }
    lineGeometry.setDrawRange(0, idx * 2);
    lineGeometry.attributes.position.needsUpdate = true;
  }

  let running = true;
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
  });

  let frame = 0;
  function animate() {
    requestAnimationFrame(animate);
    if (!running) return;

    frame++;
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] += velocities[i].x;
      positions[i * 3 + 1] += velocities[i].y;
      positions[i * 3 + 2] += velocities[i].z;

      if (Math.abs(positions[i * 3]) > SPREAD) velocities[i].x *= -1;
      if (Math.abs(positions[i * 3 + 1]) > SPREAD / 2) velocities[i].y *= -1;
      if (Math.abs(positions[i * 3 + 2]) > 7) velocities[i].z *= -1;
    }
    pointsGeometry.attributes.position.needsUpdate = true;

    // the O(n^2) link search is the priciest bit of CPU work here; running
    // it every 3rd frame instead of every frame is imperceptible for slowly
    // drifting points but cuts that cost by a third.
    if (frame % 3 === 0) updateLines();

    camera.position.x += (mouseX * 2 - camera.position.x) * 0.02;
    camera.position.y += (-mouseY * 1.2 - camera.position.y) * 0.02;
    camera.lookAt(scene.position);

    renderer.render(scene, camera);
  }
  animate();

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth * RENDER_SCALE, window.innerHeight * RENDER_SCALE, false);
    }, 150);
  }, { passive: true });
}
