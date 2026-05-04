/** Same identifier as `b.ts` — private top-level const must not collide in the flat bundle. */
const DUPLICATE_PRIVATE_TOP_LEVEL = 'from-private-dup-a';

export function readPrivateDupA(): string {
    return DUPLICATE_PRIVATE_TOP_LEVEL;
}
