/**
 * Package-owned invariant companion for `dsh-userspace-bash`.
 * @module dsh-userspace-bash/invariant
 */
const PACKAGE_NAME = "dsh-userspace-bash";
/** Cordis companion plugin name. */
const name = "userspace-bash-invariant";
/** Services required before the companion can register. */
const inject = ["invariants"];
/**
 * No runtime invariant: this executor advertises a sandbox mode but never
 * confines; file-effect enforcement is delegated to the userspace-gate gates
 * at tools/pre-execute. The mode advertisement is a documented deviation from
 * the official capability-fact semantics (see the package README).
 */
const install = () => {};
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
export { apply, inject, name };
