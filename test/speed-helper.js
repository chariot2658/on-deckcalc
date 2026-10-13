// Browser simworker.js adapter for the --helpers benchmark. Real workers exercise structured cloning and scheduling.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { parentPort, workerData } = require("worker_threads");
const S = require(path.resolve(workerData.simulate || path.join(__dirname, "../simulate.js")));
const loadReplay = require("./replay.js");
const context = vm.createContext({
  Simulate: { ...S, loadReplay },
  Engine: require(path.resolve(workerData.engine || path.join(__dirname, "../engine.js"))),
  importScripts() {},
  self: { postMessage: (msg) => parentPort.postMessage(msg) },
});
vm.runInContext(fs.readFileSync(workerData.simworker || path.join(__dirname, "../simworker.js"), "utf8"), context);
parentPort.on("message", (data) => context.self.onmessage({ data }));
