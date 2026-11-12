import type { KeyboardEvent } from "react";
/** Явное замыкание Tab в нативном dialog, в том числе после disabled/ошибки формы. */
export function trapDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const elements = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.getClientRects().length);
  const first = elements[0],
    last = elements.at(-1);
  if (!first || !last) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  const active = document.activeElement;
  if (
    event.shiftKey &&
    (active === first || !event.currentTarget.contains(active))
  ) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (active === last || !event.currentTarget.contains(active))
  ) {
    event.preventDefault();
    first.focus();
  }
}
