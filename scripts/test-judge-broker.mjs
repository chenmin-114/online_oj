import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

class TestResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status || 200;
    this.webSocket = init.webSocket;
    this.ok = this.status >= 200 && this.status < 300;
  }

  static json(value, init = {}) {
    const response = new TestResponse(JSON.stringify(value), init);
    response.value = value;
    response.json = async () => value;
    return response;
  }
}

class TestSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.attachment = null;
  }

  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code, reason) { this.readyState = 3; this.closeCode = code; this.closeReason = reason; }
}

let lastPair;
globalThis.Response = TestResponse;
globalThis.WebSocketRequestResponsePair = class {};
globalThis.WebSocketPair = class {
  constructor() {
    lastPair = [new TestSocket(), new TestSocket()];
    return lastPair;
  }
};

const workerSource = await readFile(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');
const { JudgeBroker } = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);
const configs = new Map();
const sockets = [];
const context = {
  storage: {
    sql: {
      exec(sql, ...args) {
        if (sql.includes('INSERT INTO node_config')) {
          const [nodeId, maxSlots, acceptingJobs] = args;
          const revoked = sql.includes('VALUES (?, 1, 0, 1') ? 1 : 0;
          configs.set(nodeId, {
            max_slots: revoked ? 1 : maxSlots,
            accepting_jobs: revoked ? 0 : acceptingJobs,
            revoked,
          });
          return [];
        }
        if (sql.includes('SELECT max_slots')) {
          return configs.has(args[0]) ? [configs.get(args[0])] : [];
        }
        return [];
      },
    },
  },
  setWebSocketAutoResponse() {},
  acceptWebSocket(socket) { sockets.push(socket); },
  getWebSockets(tag) {
    return sockets.filter(socket => socket.readyState === 1
      && (!tag || socket.attachment?.nodeId === tag));
  },
};

const nodeId = `jn_${'a'.repeat(22)}`;
const broker = new JudgeBroker(context);
const unavailable = broker.enqueueJob({ payload: { source_code: 'MA==', stdin: '', language_id: 103 } });
assert.equal(unavailable.status, 503);
assert.equal(unavailable.value.code, 'LOCAL_NODE_UNAVAILABLE');
broker.configureNode({ nodeId, maxSlots: 2, acceptingJobs: true });
const connection = broker.connectNode(new Request('https://broker/connect', {
  headers: { Upgrade: 'websocket', 'X-Judge-Node-Id': nodeId },
}));
assert.equal(connection.status, 101);
const server = lastPair[1];
const connected = server.sent.shift();
assert.equal(connected.type, 'connected');
await broker.webSocketMessage(server, JSON.stringify({ type: 'capacity', freeSlots: 2, sequence: 1 }));

const first = broker.enqueueJob({ payload: { source_code: 'MQ==', stdin: '', language_id: 103 } });
const second = broker.enqueueJob({ payload: { source_code: 'Mg==', stdin: '', language_id: 103 } });
const jobs = server.sent.splice(0);
assert.equal(jobs.length, 2);
assert.notEqual(jobs[0].jobId, jobs[1].jobId);
assert.notEqual(jobs[0].slotId, jobs[1].slotId);

await broker.webSocketMessage(server, JSON.stringify({
  type: 'complete', sequence: 2, jobId: jobs[0].jobId, slotId: jobs[0].slotId,
  leaseToken: jobs[0].leaseToken, status: 200, result: { stdout: 'MQo=' },
}));
assert.deepEqual((await first).value, { stdout: 'MQo=' });

await broker.webSocketMessage(server, JSON.stringify({
  type: 'complete', sequence: 3, jobId: jobs[0].jobId, slotId: jobs[0].slotId,
  leaseToken: jobs[0].leaseToken, status: 200, result: { stdout: 'YmFk' },
}));
assert.equal(server.sent.at(-1).code, 'JOB_LEASE_EXPIRED');

broker.webSocketClose(server);
assert.equal((await second).status, 502);
assert.equal(broker.activeJobs.size, 0);
assert.equal(broker.activeSlotKeys.size, 0);

console.log('JudgeBroker WebSocket scheduling tests passed.');
