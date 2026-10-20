// The pull path (spec #18, stories 14-20): the wallet talks to a chain's Sidechain Server, the one
// its Chain Entry names for the network the Chain Module serves, in the Server API it names: a
// Slot's, or eCash's own (#30; it reads state only, Send on L1 comes with Deposit, #31). The
// wallet derives the addresses it watches (the server never hands any out), shows the state the
// server reports, and sends by having the server build a Signing Request that then takes the same
// review as any other.
import { createKeyRouting, type ChainModules, type KeyedChain, type Keys } from "./accounts";
import type { AssetAmount, ChainEntry, ChainKey, NetworkEntry, Starter } from "./chain-module";
import { ErrorCode, ProviderRpcError } from "./errors";
import type { SidechainServer, TransferOrder, WatchData } from "./sidechain-server";
import { parseSigningRequest } from "./signing-request";
import { chainModuleFor, reviewAndSign, type SigningDeps } from "./signing";

/** Receive addresses the wallet watches: the gap a server watches ahead of the first unused one. */
export const WATCHED_RECEIVE_ADDRESSES = 20;
/** Change addresses the wallet watches, for servers that only see addresses (Esplora). */
export const WATCHED_CHANGE_ADDRESSES = 20;

export interface PullPathDeps extends SigningDeps, Keys, ChainModules {
  /** A client for `network`'s default Sidechain Server, in the Server API its Chain Entry names. */
  sidechainServer(entry: ChainEntry, network: NetworkEntry): SidechainServer;
}

/** A chain with its Chain Module, its key and the Sidechain Server it talks to. */
type ChainServer<K extends ChainKey> = KeyedChain<K> & { server: SidechainServer };

/** A chain's balance as its Sidechain Server reports it. */
export interface ChainReport {
  chain: string;
  /** Who reported it. */
  server: string;
  balances: AssetAmount[];
  history: unknown[];
}

/** A Slot's balance as its Sidechain Server reports it. */
export interface SlotReport extends ChainReport {
  slot: number;
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
  const routing = createKeyRouting(deps);

  /** The chain's Sidechain Server: its Chain Entry's default for the network its module serves. */
  function withServer<K extends ChainKey>(target: KeyedChain<K>): ChainServer<K> {
    return { ...target, server: deps.sidechainServer(target.entry, target.network) };
  }

  /** The chain's watch data, derived from its key by its Chain Module. */
  async function watch<K extends ChainKey>({ module, chain, key }: ChainServer<K>): Promise<WatchData> {
    const { descriptor, receive, change } = module.deriveAccount(await key(), {
      receive: WATCHED_RECEIVE_ADDRESSES,
      change: WATCHED_CHANGE_ADDRESSES,
    });
    return { chain, descriptor, receive, change };
  }

  async function reported<K extends ChainKey>(target: ChainServer<K>): Promise<ChainReport> {
    const { chain, server } = target;
    const { balances, history } = await server.state(await watch(target));
    return { chain, server: server.url, balances, history };
  }

  return {
    /** What the Slot's server reports for the addresses the wallet watches. */
    async reportedState(slot: number): Promise<SlotReport> {
      return { slot, ...(await reported(withServer(await routing.slot(slot)))) };
    },

    /** What eCash's server reports for the L1 addresses the wallet watches. */
    async reportedL1State(): Promise<ChainReport> {
      return reported(withServer(await routing.l1()));
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
      const target: ChainServer<Starter> = withServer(await routing.slot(slot));
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
