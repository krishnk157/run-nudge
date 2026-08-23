"use client";

import { useEffect, useState } from "react";

/**
 * An explicit "Install" control in the header.
 *
 * A PWA is installable long before anything says so: iOS Safari never shows a
 * prompt at all (install is buried in the Share sheet), and Chrome retired its
 * auto-banner years ago in favour of a menu item most people never look for.
 * "Intended mostly for a phone" and "no way to tell it can be installed" don't
 * sit together, so the app surfaces install itself.
 *
 * Two paths, because the platforms give us two:
 *   - Chrome/Android/desktop fire `beforeinstallprompt`; we capture it and
 *     replay it on click, which is the real native install dialog.
 *   - iOS gives us no event, so the button reveals the one manual route that
 *     exists there: Share → Add to Home Screen.
 *
 * The button hides itself once the app is running installed (standalone), so it
 * never nags someone who already has it.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari's non-standard flag for a home-screen launch.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function InstallButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [isIOS, setIsIOS] = useState(false);
  const [installed, setInstalled] = useState(true); // assume yes until mounted
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    if (isStandalone()) {
      setInstalled(true);
      return;
    }
    setInstalled(false);

    const ua = navigator.userAgent;
    // iPadOS 13+ reports as a Mac, but it is the only touch Mac, so gate on that.
    const iOS =
      /iphone|ipod|ipad/i.test(ua) ||
      (navigator.maxTouchPoints > 1 && /macintosh/i.test(ua));
    setIsIOS(iOS);

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
      setShowHint(false);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Nothing to offer: already installed, or a browser that exposes no route.
  if (installed) return null;
  if (!deferred && !isIOS) return null;

  const onClick = async () => {
    if (deferred) {
      await deferred.prompt();
      await deferred.userChoice;
      setDeferred(null);
      return;
    }
    setShowHint((v) => !v);
  };

  return (
    <div className="install-wrap">
      <button
        className="btn"
        type="button"
        onClick={onClick}
        aria-expanded={isIOS ? showHint : undefined}
      >
        Install
      </button>
      {showHint && isIOS && (
        <div className="install-hint" role="status">
          Tap <b>Share</b>, then <b>Add to Home Screen</b>.
        </div>
      )}
    </div>
  );
}
