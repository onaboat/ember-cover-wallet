export interface BrowserWindowBounds {
  left: number
  top: number
  width: number
}

export interface PopupPosition {
  left: number
  top: number
}

/**
 * Top-right placement for the dapp approval window, near the toolbar icons (the
 * Phantom/MetaMask convention) instead of the OS default centering. Computed from
 * the focused browser window so it lands on the same display the dapp is on.
 */
export function topRightPopupPosition(
  bounds: BrowserWindowBounds,
  popupWidth: number,
  margin: number,
): PopupPosition {
  return {
    left: Math.max(0, Math.round(bounds.left + bounds.width - popupWidth - margin)),
    top: Math.max(0, Math.round(bounds.top + margin)),
  }
}
