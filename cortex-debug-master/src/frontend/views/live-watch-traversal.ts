/**
 * Monitor-all follows one pointer hop to expose ordinary handle targets.
 * More pointer hops need an explicit expansion or a plot subscription so
 * recursive object graphs cannot grow without bound.
 */
export function shouldTraverseLiveChildren(
    isPointer: boolean, expanded: boolean, monitorAll: boolean, plotDescendant: boolean,
    isLeaf = false, pointerAncestors = 0
): boolean {
    return !isLeaf && (expanded || plotDescendant
        || (monitorAll && (!isPointer || pointerAncestors === 0)));
}
