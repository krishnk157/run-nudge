"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

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
  const [showHint, setShowHint] = useState(false);

  /*
   * Both of these are facts about the environment, not state this component
   * owns, so they are read during render rather than assigned in an effect.
   * Writing them with setState in an effect is what react-hooks/purity flags,
   * and the rule is right here: an effect that immediately sets state renders
   * the wrong thing once and then corrects it.
   *
   * The server snapshot says "installed" so the button never flashes into view
   * during hydration and then disappear for someone who already has the app.
   */
  const installed = useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia("(display-mode: standalone)");
      mq.addEventListener("change", onChange);
      window.addEventListener("appinstalled", onChange);
      return () => {
        mq.removeEventListener("change", onChange);
        window.removeEventListener("appinstalled", onChange);
      };
    },
    () => isStandalone(),
    () => true,
  );

  const isIOS = useSyncExternalStore(
    () => () => {},
    () => {
      const ua = navigator.userAgent;
      // iPadOS 13+ reports as a Mac, but it is the only touch Mac.
      return (
        /iphone|ipod|ipad/i.test(ua) ||
        (navigator.maxTouchPoints > 1 && /macintosh/i.test(ua))
      );
    },
    () => false,
  );

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      // `installed` is now derived from the same event via useSyncExternalStore;
      // this only clears the UI that was offering the install.
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
