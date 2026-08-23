// TronHawk PoC bootstrap — proves injection into the target Electron MAIN process.
// Loaded via `require(process.env.MODLOADER_MOD_ENTRYPOINT)` from the remapped app.asar.
const fs = require("fs");
const path = require("path");
const os = require("os");

const marker = path.join(os.tmpdir(), "tronhawk-poc-injected.txt");

const payload = [
  "TRONHAWK POC: injected into MAIN process",
  "time=" + new Date().toISOString(),
  "electron=" + (process.versions.electron || "unknown"),
  "node=" + (process.versions.node || "unknown"),
  "argv=" + JSON.stringify(process.argv),
].join("\n");

fs.writeFileSync(marker, payload + "\n");
console.log(
  "[tronhawk-poc] bootstrap ran in main process (electron " +
    process.versions.electron +
    ")",
);
