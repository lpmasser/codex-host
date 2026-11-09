/** Desktop can retain the exit animation's 0fr value after restoring a chat.
 * Its presence marker has already returned to "present", but Motion remembers
 * the unchanged 1fr target and leaves the queued messages clipped indefinitely.
 * Use native presence as the height authority; exiting/concealed items retain
 * their native behavior. This intentionally skips the rail's entrance resize.
 */
export function installRendererComposerRailStyle(ownerDocument: Document): () => void {
  const style = ownerDocument.createElement("style");
  style.setAttribute("data-codexhost-composer-rail-style", "true");
  style.textContent = `
    [data-composer-rail-contained][data-composer-rail-item="present"]:not([inert]):not([aria-hidden="true"]) {
      grid-template-rows: 1fr !important;
    }
  `;
  ownerDocument.head.append(style);
  return () => style.remove();
}
