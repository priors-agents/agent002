// The sandbox's facilitator: the official x402 EVM facilitator scheme (@x402/evm), settling on the local fork with a
// fork-only wallet that pays the gas (agent001's, unchanged). On mainnet agent002 uses the Priors facilitator instead
// (facilitator.priors.trade), with each worker's API key from `agent002 merchant register`; this file is only ever
// used in the sandbox, by the Node service.
import { ethers } from "ethers";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { robinhood } from "@priors/x402";

const fragmentFor = (iface, name, args) => {
  const fs = iface.fragments.filter((f) => f.type === "function" && f.name === name && f.inputs.length === args.length);
  if (fs.length !== 1) throw new Error(`no single ${name}(${args.length} args) in the ABI`);
  return fs[0];
};

/** The FacilitatorEvmSigner @x402/evm expects (viem-shaped), on an ethers wallet. */
export function ethersFacilitatorSigner(wallet) {
  const provider = wallet.provider;
  return {
    getAddresses: () => [wallet.address],
    async readContract({ address, abi, functionName, args = [] }) {
      const c = new ethers.Contract(address, abi, provider);
      const f = fragmentFor(c.interface, functionName, args);
      const r = await c.getFunction(f.format("sighash")).staticCall(...args);
      return r;
    },
    async verifyTypedData({ address, domain, types, message, signature }) {
      const { EIP712Domain, ...rest } = types; // ethers derives the domain type itself
      try { return ethers.verifyTypedData(domain, rest, message, signature).toLowerCase() === address.toLowerCase(); } catch (_) { return false; }
    },
    async writeContract({ address, abi, functionName, args, gas }) {
      const c = new ethers.Contract(address, abi, wallet);
      const f = fragmentFor(c.interface, functionName, args);
      const tx = await c.getFunction(f.format("sighash"))(...args, gas ? { gasLimit: gas } : {});
      return tx.hash;
    },
    async sendTransaction({ to, data }) { return (await wallet.sendTransaction({ to, data })).hash; },
    async waitForTransactionReceipt({ hash, timeout }) {
      const rc = await provider.waitForTransaction(hash, 1, timeout || 60_000);
      return { status: rc && rc.status === 1 ? "success" : "reverted", logs: rc ? rc.logs : [] };
    },
    async getCode({ address }) { const c = await provider.getCode(address); return c === "0x" ? undefined : c; },
  };
}

/** A FacilitatorClient (verify, settle, getSupported) that settles in-process on the fork. */
export function localFacilitator(wallet) {
  const f = new x402Facilitator().register(robinhood.network, new ExactEvmScheme(ethersFacilitatorSigner(wallet)));
  return {
    verify: (payload, requirements) => f.verify(payload, requirements),
    settle: (payload, requirements) => f.settle(payload, requirements),
    getSupported: async () => f.getSupported(),
  };
}
