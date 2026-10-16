// No native share event can arrive in a browser. A stable empty value lets
// surrounding UI render without reporting a successful share operation.
const empty = { hasShareIntent: false, shareIntent: { text: null, webUrl: null, files: null, meta: {} }, resetShareIntent() {}, error: null };
export const useShareIntent = () => empty;
