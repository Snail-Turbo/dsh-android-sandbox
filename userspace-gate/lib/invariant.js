//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `dsh-userspace-gate`.
* @module dsh-userspace-gate/invariant
*/
const PACKAGE_NAME = "dsh-userspace-gate";
/** Cordis companion plugin name. */
const name = "userspace-gate-invariant";
/** Services required before the companion can register. */
const inject = ["invariants"];
/** No runtime invariant: this stateless gate delegates policy and containment to their owning seams. */
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
