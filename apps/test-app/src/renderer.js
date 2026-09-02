document.addEventListener("DOMContentLoaded", () => {
  const addNodeButton = document.querySelector("#add-node");
  const container = document.querySelector("#container");
  const status = document.querySelector("#status");
  let nodeCount = 0;

  addNodeButton.addEventListener("click", () => {
    nodeCount += 1;
    const node = document.createElement("div");
    node.className = "node";
    node.textContent = `node-${nodeCount}`;
    container.appendChild(node);
  });

  window.testApp.ping().then((result) => {
    status.textContent = result;
  });
});

// Late-mounted element so the Phase B timing seam has a deterministic consumer: it appears only
// after an initial quiet window following DOMContentLoaded.
setTimeout(() => {
  const late = document.createElement("div");
  late.id = "late-root";
  late.textContent = "late-mount-ok";
  document.body.appendChild(late);
}, 1200);
