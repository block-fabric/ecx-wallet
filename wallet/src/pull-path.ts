// The pull path (spec #18, stories 14-20): the wallet talks to a Slot's Sidechain Server, the one
// its Chain Entry names for the network the Chain Module serves, in the Server API it names. The
// wallet derives the addresses it watches (the server never hands any out), shows the state the
// server reports, and sends by having the server build a Signing Request that then takes the same
// review as any other.
import { slotChainModule } from "./accounts";
import type { AssetAmount, ChainEntry, ChainModule, NetworkEntry } from "./chain-module";
import { ErrorCode, ProviderRpcError } from "./errors";
import type { SidechainServer, TransferOrder, WatchData } from "./sidechain-server";
import { parseSigningRequest } from "./signing-request";
import { chainModuleFor, reviewAndSign, type SigningDeps } from "./signing";

/** Receive addresses the wallet watches: the gap a server watches ahead of the first unused one. */
export const WATCHED_RECEIVE_ADDRESSES = 20;
/** Change addresses the wallet watches, for servers that only see addresses (Esplora). */
export const WATCHED_CHANGE_ADDRESSES = 20;

export interface PullPathDeps extends SigningDeps {
  /** A client for `network`'s default Sidechain Server, in the Server API its Chain Entry names. */
  sidechainServer(entry: ChainEntry, network: NetworkEntry): SidechainServer;
}

/** A Slot with its Chain Module and the Sidechain Server it talks to. */
interface SlotServer {
  slot: number;
  module: ChainModule;
  /** CAIP-2 chain the module serves. */
  chain: string;
  server: SidechainServer;
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
  async function slotServer(slot: number): Promise<SlotServer> {
    const { module, chain } = await slotChainModule(deps.chainModule, slot);
    const entry = module.chainEntry();
    const network = Object.values(entry.networks).find((n) => n.chain === chain);
    if (network === undefined) throw new Error(`Slot ${slot}'s Chain Entry has no network for ${chain}.`);
    return { slot, module, chain, server: deps.sidechainServer(entry, network) };
  }

  /** The Slot's watch data, derived from its Starter by its Chain Module. */
  async function watch({ slot, module, chain }: SlotServer): Promise<WatchData> {
    const { descriptor, receive, change } = module.deriveAccount(await deps.starter(slot), {
      receive: WATCHED_RECEIVE_ADDRESSES,
      change: WATCHED_CHANGE_ADDRESSES,
    });
    return { chain, descriptor, receive, change };
  }

  return {
    /** What the Slot's server reports for the addresses the wallet watches. */
    async reportedState(slot: number): Promise<SlotReport> {
      const target = await slotServer(slot);
      const { chain, server } = target;
      const { balances, history } = await server.state(await watch(target));
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
      const target = await slotServer(slot);
      const { server } = target;
      const watched = await watch(target);
      const built = await server.buildTransfer(watched, { ...order, destination: order.destination.trim() });

      const request = parseSigningRequest(built, Math.floor(deps.now() / 1000));
      if (request.slot !== slot) {
        throw new ProviderRpcError(ErrorCode.InvalidParams, `Slot ${slot}'s Sidechain Server sent a request for ${request.chain}.`);
      }
      const module = await chainModuleFor(deps, request);
      const signed = await reviewAndSign(deps, { requester: server.url, request, module, blindRefusal: BLIND_REFUSED });
      const { accepted, txid } = await server.submit(watched, request.id, signed);
      return { requestId: request.id, server: server.url, accepted, ...(txid ? { txid } : {}) };
    },
  };
}

export type PullPath = ReturnType<typeof createPullPath>;
export type { TransferOrder };
