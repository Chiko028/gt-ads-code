import Fastify from "fastify";
import { Readable } from "node:stream";
const LIMIT = 1_000_000_000;
const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: LIMIT }, (_req, body, done) => done(null, body));
app.post("/u", { bodyLimit: LIMIT }, async (req, reply) => reply.code(201).send({ n: req.body.length }));
await app.ready();
const shared = Buffer.alloc(1024 * 1024, 0x41);
function* gen(total) {
  let sent = 0;
  while (sent < total) {
    const n = Math.min(shared.length, total - sent);
    sent += n;
    yield n === shared.length ? shared : shared.subarray(0, n);
  }
}
const t = Date.now();
const res = await app.inject({ method: "POST", url: "/u", headers: { "content-type": "application/octet-stream" }, payload: Readable.from(gen(LIMIT + 1)) });
console.log(JSON.stringify({ status: res.statusCode, ms: Date.now() - t, rssMb: Math.round(process.memoryUsage().rss / 1048576) }));
await app.close();
