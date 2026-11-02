import type { Modal } from 'obsidian';

/**
 * Keep a review dialog open when a click lands outside it.
 *
 * A review dialog holds output that took the model tens of seconds to make,
 * and Obsidian closes any dialog on a click on the dimmed background. One
 * stray click while waiting threw the draft away, and nothing said so, so it
 * looked as though the command had failed. Cancel, the close button and
 * Escape still close it; those are on purpose.
 *
 * Capture on the container stops the click before it reaches the background,
 * which on macOS closes the dialog directly rather than through a hook a
 * subclass could override.
 */
export function keepOpenOnOutsideClick(modal: Modal): void {
  const bg = modal.containerEl.querySelector('.modal-bg');
  modal.containerEl.addEventListener(
    'click',
    (e) => {
      if (e.target === bg) e.stopPropagation();
    },
    true
  );
}
