/** Same identifier as `a.ts` — private top-level const must not collide in the flat bundle. */
const DUPLICATE_PRIVATE_TOP_LEVEL = 'from-private-dup-b';

export function readPrivateDupB(): string {
    return DUPLICATE_PRIVATE_TOP_LEVEL;
}
