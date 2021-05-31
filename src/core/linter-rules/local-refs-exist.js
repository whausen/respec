// @ts-check
/**
 * Linter rule "warn-local-ref".
 * Warns about href's that link to nonexistent id's in a spec
 */
import { getIntlData, showWarning } from "../utils.js";

const ruleName = "local-refs-exist";
export const name = "core/linter-rules/local-refs-exist";

const localizationStrings = {
  en: {
    msg: "Broken local reference found in document.",
    hint: "Please fix the links mentioned.",
  },
};
const l10n = getIntlData(localizationStrings);

export function run(conf) {
  if (!conf.lint?.[ruleName]) {
    return;
  }

  /** @type {NodeListOf<HTMLAnchorElement>} */
  const elems = document.querySelectorAll("a[href]");
  const baseURI = new URL(document.baseURI);
  const offendingElements = [...elems].filter(elem =>
    isBrokenHyperlink(elem, baseURI)
  );
  if (offendingElements.length) {
    showWarning(l10n.msg, name, {
      hint: l10n.hint,
      elements: offendingElements,
    });
  }
}

/**
 * @param {HTMLAnchorElement} elem
 * @param {URL} baseURI
 */
function isBrokenHyperlink(elem, baseURI) {
  if (!elem.hash) {
    return false;
  }
  if (elem.origin === baseURI.origin && elem.pathname !== baseURI.pathname) {
    // skip fragment links outside current page
    return false;
  }

  const id = decodeURIComponent(elem.hash.substring(1));
  const doc = elem.ownerDocument;
  return !doc.getElementById(id) && !doc.getElementsByName(id).length;
}
