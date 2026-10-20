// The stub Elements Sidechain Server: the standard Sidechain Server API (pull side) answered from
// fixtures. Reference for sidechain teams and the e2e suite's server. The protocol it implements is
// documented in ../README.md; keep the two in step.
//
// Dependency-free node `http`. It never hands out addresses, never signs and never broadcasts.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const MAX_BODY = 1 << 20;

/**
 * @typedef {{ asset: string, amount: string }} AssetAmount
 * @typedef {{ balances: AssetAmount[], history: object[] }} ReportedState
 * @typedef {{ asset: string, amount: string, destination: string, payload: string, expiresIn?: number,
 *   hints?: { summary?: string, outputLabels?: Record<string, string> } }} TransferFixture
 * @typedef {{
 *   chain?: string,
 *   state?: Record<string, ReportedState>,
 *   transfers?: TransferFixture[],
 *   now?: () => number,
 * }} StubConfig
 */

/**
 * A stub server answering from `config`:
 * - `state`: reported state per address; a watch's state is the sum of its registered addresses'.
 * - `transfers`: the transfers it can build, matched exactly on (asset, amount, destination); the
 *   request's `expiresAt` is now + `expiresIn` seconds (default 600).
 */
export function createStubServer(config = {}) {
  const chain = config.chain ?? "ecash:betanet-s24";
  const now = config.now ?? (() => Date.now());
  /** watchId → registration */
  const watches = new Map();
  /** requestId → { watchId, transfer } */
  const issued = new Map();
  const registrations = [];
  const submissions = [];

  /** @returns {Promise<[number, unknown]>} */
  async function route(method, url, body) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1" || parts[1] !== "watch") return notFound();

    // POST /v1/watch
    if (parts.length === 2) {
      if (method !== "POST") return methodNotAllowed();
      const watch = parseWatch(body);
      if (typeof watch === "string") return badRequest(watch);
      if (watch.chain !== chain) return badRequest(`This server serves ${chain}, not ${watch.chain}.`);
      const watchId = createHash("sha256").update(`${watch.chain}\n${watch.descriptor}`).digest("hex").slice(0, 32);
      const known = watches.get(watchId);
      const addresses = new Map((known?.addresses ?? []).map((a) => [a.address, a]));
      for (const a of watch.addresses) addresses.set(a.address, a);
      watches.set(watchId, { ...watch, addresses: [...addresses.values()] });
      registrations.push(structuredClone(watch));
      return [200, { watchId }];
    }

    const watch = watches.get(parts[2]);
    if (watch === undefined) return [404, error("unknownWatch", "Register this watch first: POST /v1/watch.")];
    const watchId = parts[2];

    // GET /v1/watch/{watchId}/state
    if (parts.length === 4 && parts[3] === "state") {
      if (method !== "GET") return methodNotAllowed();
      return [200, { chain, ...reportedState(watch) }];
    }

    // POST /v1/watch/{watchId}/transfers
    if (parts.length === 4 && parts[3] === "transfers") {
      if (method !== "POST") return methodNotAllowed();
      const { asset, amount, destination } = body ?? {};
      if (typeof asset !== "string" || typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount) || typeof destination !== "string") {
        return badRequest("A transfer needs `asset` (hex), `amount` (base units, decimal string) and `destination`.");
      }
      const transfer = (config.transfers ?? []).find(
        (t) => t.asset === asset && t.amount === amount && t.destination === destination,
      );
      if (transfer === undefined) return [422, error("cannotBuild", "This stub can only build the transfers in its fixture table.")];
      const id = randomUUID();
      issued.set(id, { watchId, transfer });
      return [200, {
        version: "1.0",
        id,
        chain,
        method: "signTransaction",
        format: "pset",
        payload: transfer.payload,
        expiresAt: Math.floor(now() / 1000) + (transfer.expiresIn ?? 600),
        ...(transfer.hints ? { hints: transfer.hints } : {}),
      }];
    }

    // POST /v1/watch/{watchId}/submissions
    if (parts.length === 4 && parts[3] === "submissions") {
      if (method !== "POST") return methodNotAllowed();
      const { requestId, payload } = body ?? {};
      if (typeof requestId !== "string" || typeof payload !== "string" || payload === "") {
        return badRequest("A submission needs `requestId` and `payload` (base64).");
      }
      const request = issued.get(requestId);
      if (request === undefined || request.watchId !== watchId) {
        return [404, error("unknownRequest", "This server issued no such Signing Request to this watch.")];
      }
      if (submissions.some((s) => s.requestId === requestId)) {
        return [409, error("alreadySubmitted", "This Signing Request was already submitted.")];
      }
      submissions.push({ watchId, requestId, payload });
      return [200, { requestId, accepted: true }];
    }

    return notFound();
  }

  function reportedState(watch) {
    const totals = new Map();
    const history = [];
    for (const { address } of watch.addresses) {
      const state = config.state?.[address];
      if (state === undefined) continue;
      for (const { asset, amount } of state.balances) totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(amount));
      history.push(...state.history);
    }
    return { balances: [...totals].map(([asset, amount]) => ({ asset, amount: amount.toString() })), history };
  }

  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json", ...CORS });
      response.end(JSON.stringify(body));
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS);
      response.end();
      return;
    }
    try {
      const body = request.method === "POST" ? await readJson(request) : undefined;
      if (body === INVALID_JSON) return send(400, error("badRequest", "The body must be JSON."));
      const [status, answer] = await route(request.method, new URL(request.url, "http://stub"), body);
      send(status, answer);
    } catch (e) {
      send(500, error("internal", String(e)));
    }
  });

  return {
    /** Listens on `host:port`; resolves with the base URL. */
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(`http://${host}:${server.address().port}`));
      });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
    /** Every POST /v1/watch body received, in order. */
    registrations: () => structuredClone(registrations),
    /** Every accepted submission, in order. */
    submissions: () => structuredClone(submissions),
  };
}

// The wallet's extension pages and background are another origin, so every answer allows CORS
// (including Chromium's Private Network Access preflight for loopback).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Private-Network": "true",
};

const INVALID_JSON = Symbol("invalid JSON");

async function readJson(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > MAX_BODY) return INVALID_JSON;
  }
  try {
    return JSON.parse(text);
  } catch {
    return INVALID_JSON;
  }
}

function parseWatch(body) {
  const { chain, descriptor, addresses } = body ?? {};
  if (typeof chain !== "string") return "A watch needs `chain`.";
  if (typeof descriptor !== "string" || descriptor === "") return "A watch needs `descriptor`.";
  if (
    !Array.isArray(addresses) ||
    !addresses.every((a) => Number.isInteger(a?.index) && typeof a.address === "string" && typeof a.scriptPubkey === "string")
  ) {
    return "A watch needs `addresses`: [{ index, address, scriptPubkey }].";
  }
  return {
    chain,
    descriptor,
    addresses: addresses.map(({ index, address, scriptPubkey }) => ({ index, address, scriptPubkey })),
  };
}

const error = (code, message) => ({ error: { code, message } });
const badRequest = (message) => [400, error("badRequest", message)];
const notFound = () => [404, error("notFound", "No such endpoint.")];
const methodNotAllowed = () => [405, error("methodNotAllowed", "Method not allowed.")];
