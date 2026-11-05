/** Cloudflare's Worker scripts DELETE contract explicitly permits an empty success
 * body. Pinned public SDK: cloudflare/cloudflare-typescript@5ba0c3d36e3f3a7b12990b55649517b1d5c4914c
 * src/resources/workers/scripts/scripts.ts. This is a response-shape exception,
 * NOT proof of deletion: the executor must still read back a 10007 absence.
 * Do not broaden this to arbitrary endpoints, webhooks, 202, or whitespace/HTML. */
export function emptyWorkerDeleteResponse(url: string, method: string, status: number, byteLength: number): boolean {
    if (method.toUpperCase()!=='DELETE' || ![200,204].includes(status) || byteLength!==0) return false;
    try {
        const target=new URL(url);
        return target.origin==='https://api.cloudflare.com' && !target.username && !target.password && !target.search && !target.hash &&
            /^\/client\/v4\/accounts\/[a-f0-9]{32}\/workers\/scripts\/[a-z0-9][a-z0-9_-]{0,62}$/.test(target.pathname);
    } catch { return false; }
}
