// Temporary stub, replaced by the real Setup screens in the next commit.
import { h, clear } from "./dom.mjs";
const stub = (title) => async (root) => { clear(root).append(h("div", { class: "page-narrow" }, h("h1", null, title))); };
export const mountSetup = stub("Setup");
export const mountProviderForm = stub("Provider");
export const mountRouting = stub("Routing & budget");
