// The pull path (spec #18, stories 14-20): the wallet talks to a Slot's Sidechain Server, the one
// its Chain Entry names for the network the Chain Module serves. The wallet derives and registers
// the addresses (the server never hands any out), shows the state the server reports, and sends
// by having the server build a Signing Request that then takes the same review as any other.
import type { AssetAmount, ChainModule } from "./chain-module";
import { ErrorCode, ProviderRpcError } from "./errors";
import type { SidechainServer, TransferOrder } from "./sidechain-server";
import { parseSigningRequest } from "./signing-request";
import { chainModuleFor, reviewAndSign, type SigningDeps } from "./signing";

/** Addresses registered with the server: the gap a server watches ahead of the first unused one. */
export const WATCHED_RECEIVE_ADDRESSES = 20;

export interface PullPathDeps extends SigningDeps {
  /** A client for the Sidechain Server at `url`. */
  sidechainServer(url: string): SidechainServer;
}

/** A Slot's balance as its Sidechain Server reports it. */
export interface SlotReport {
  slot: number;
  chain: string;
  /** Who reported it. */
  server: string;
  balances: AssetAmount[];
  history: unknown[];
}

/** A send the Sidechain Server accepted. */
export interface SendResult {
  requestId: string;
  server: string;
  accepted: boolean;
  txid?: string;
}

/** Why a server-built request that needs Blind Signing is refused: there is no Grant to opt in. */
const BLIND_REFUSED =
  "The wallet can't fully explain the transaction the Sidechain Server built, so it won't sign it: " +
  "a Sidechain Server's request must be Clear Signed.";

export function createPullPath(deps: PullPathDeps) {
  /** The Slot's Chain Module and its Sidechain Server (the Chain Entry's default for its network). */
  async function connection(slot: number) {
    const pending = deps.chainModule(slot);
    if (pending === undefined) throw new Error(`No Chain Module for Slot ${slot}.`);
    const module = await pending;
    const { chain } = module.declare().binding;
    const network = Object.values(module.chainEntry().networks).find((n) => n.chain === chain);
    if (network === undefined) throw new Error(`Slot ${slot}'s Chain Entry has no network for ${chain}.`);
    return { module, chain, server: deps.sidechainServer(network.sidechainServer) };
  }

  /** Registers the Slot's watch data with its server; returns the server's id for it. */
  async function register(slot: number, module: ChainModule, chain: string, server: SidechainServer): Promise<string> {
    const account = module.deriveAccount(await deps.starter(slot), { receive: WATCHED_RECEIVE_ADDRESSES });
    return server.register({ chain, descriptor: account.descriptor, addresses: account.receive });
  }

  return {
    /** Registers the Slot's addresses and returns what its server reports for them. */
    async reportedState(slot: number): Promise<SlotReport> {
      const { module, chain, server } = await connection(slot);
      const watchId = await register(slot, module, chain, server);
      const { balances, history } = await server.state(watchId);
      return { slot, chain, server: server.url, balances, history };
    },

    /**
     * The wallet's own Send: the Slot's server builds the transfer; the Signing Request it returns
     * gets the whole validation order (no Grant step: the wallet asked for it), must be Clear (no
     * Grant, so no Blind opt-in), is approved in the approval window naming the server, then signed
     * and submitted back.
     */
    async send(slot: number, order: TransferOrder): Promise<SendResult> {
      if (!/^[1-9][0-9]*$/.test(order.amount)) throw new ProviderRpcError(ErrorCode.InvalidParams, "The amount must be a whole number of base units.");
      if (order.destination.trim() === "") throw new ProviderRpcError(ErrorCode.InvalidParams, "Enter a destination address.");
      const { module: slotModule, chain, server } = await connection(slot);
      const watchId = await register(slot, slotModule, chain, server);
      const built = await server.buildTransfer(watchId, { ...order, destination: order.destination.trim() });

      const request = parseSigningRequest(built, Math.floor(deps.now() / 1000));
      if (request.slot !== slot) {
        throw new ProviderRpcError(ErrorCode.InvalidParams, `Slot ${slot}'s Sidechain Server sent a request for ${request.chain}.`);
      }
      const module = await chainModuleFor(deps, request);
      const signed = await reviewAndSign(deps, { requester: server.url, request, module, blindRefusal: BLIND_REFUSED });
      const { accepted, txid } = await server.submit(watchId, request.id, signed);
      return { requestId: request.id, server: server.url, accepted, ...(txid ? { txid } : {}) };
    },
  };
}

export type PullPath = ReturnType<typeof createPullPath>;
export type { TransferOrder };
