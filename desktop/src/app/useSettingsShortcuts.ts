import * as React from "react";

import { hasPrimaryShortcutModifier } from "@/shared/lib/platform";

type UseSettingsShortcutsOptions = {
  onClose: () => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  open?: boolean;
};

export function useSettingsShortcuts({
  onClose,
  onOpenProfile,
  onOpenSettings,
  open,
}: UseSettingsShortcutsOptions) {
  React.useLayoutEffect(() => {
    if (open === undefined) return;

    function handleKeyDown(event: KeyboardEvent) {
      const isProfileShortcut =
        hasPrimaryShortcutModifier(event) &&
        !event.altKey &&
        event.shiftKey &&
        (event.key.toLowerCase() === "p" || event.code === "KeyP");
      if (isProfileShortcut) {
        // Settings owns this route shortcut even while a composer has focus,
        // but an open dialog keeps its keyboard ownership and unsaved form.
        const dialogOpen = Array.from(
          document.querySelectorAll(
            '[role="dialog"], [role="alertdialog"], dialog[open]',
          ),
        ).some(
          (element) =>
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== "hidden",
        );
        if (
          event.repeat ||
          event.defaultPrevented ||
          event.isComposing ||
          dialogOpen
        ) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        onOpenProfile();
        return;
      }

      const isSettingsShortcut =
        hasPrimaryShortcutModifier(event) &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "," || event.code === "Comma");

      if (!isSettingsShortcut) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      if (open) {
        onClose();
        return;
      }

      onOpenSettings();
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose, onOpenProfile, onOpenSettings, open]);
}
