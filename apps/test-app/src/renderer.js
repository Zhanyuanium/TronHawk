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
