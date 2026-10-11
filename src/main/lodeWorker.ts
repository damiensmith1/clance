// One project's lode, in its own utility process (see lode.ts): indexing a
// large repository takes seconds of synchronous work, which would freeze
// the main process. The project folder is the first argument; messages
// from the window (lode's MessageConnection protocol) arrive on the parent
// port, and lode's replies, change notices and events go back on it.

const root = process.argv[2];
const port = process.parentPort;

// Requests that come in while the graph is being built wait here.
const early: unknown[] = [];
let handle: ((message: unknown) => void) | null = null;
port.on("message", (event: Electron.MessageEvent) => (handle ? handle(event.data) : early.push(event.data)));

async function start() {
  const lode = await import("lode-graph");
  const store = lode.GraphStore.open(await lode.pluginFor(root), root);
  // The judge for "/" questions: Jev, with the key Clance passed (lode.ts).
  const apiKey = process.env.TYPESAFE_API_KEY;
  const service = lode.createService(store, apiKey ? { judge: lode.jevJudge({ apiKey }) } : {});
  service.watch();
  lode.serveMessages(service, {
    send: (message) => port.postMessage(message),
    listen: (handler) => {
      handle = handler;
      for (const message of early.splice(0)) handler(message);
      return () => (handle = null);
    },
  });
}

start().catch((error) => {
  port.postMessage({ lode: 1, method: "failed", params: { error: error instanceof Error ? error.message : String(error) } });
  process.exit(1);
});
