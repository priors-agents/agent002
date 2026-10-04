// A minimal JSON-RPC client over fetch, for the few chain reads the service makes (a transaction, its receipt, the
// latest block). It runs in Node and in a Cloudflare Worker. The node's URL can be private (a key in its path), so no
// error from here ever quotes it.
export function jsonRpc(url, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  let id = 0;
  return async function call(method, params = []) {
    let r;
    try {
      r = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`the chain's RPC did not answer ${method} (${e?.name === "TimeoutError" ? "timeout" : "network error"})`);
    }
    if (!r.ok) throw new Error(`the chain's RPC answered HTTP ${r.status} to ${method}`);
    let j;
    try { j = await r.json(); } catch (_) { throw new Error(`the chain's RPC answered ${method} with something other than JSON`); }
    if (j.error) throw new Error(`the chain's RPC refused ${method}: ${String(j.error.message || j.error.code).slice(0, 200)}`);
    return j.result;
  };
}

export const hexToNumber = (h) => (h === null || h === undefined ? null : Number(BigInt(h)));
