import { useCallback, useEffect, useRef, useState } from "react";
import logo from "./assets/logo.png";
import LibraryPage from "./pages/LibraryPage";
import BrowsePage from "./pages/BrowsePage";
import SpikePage from "./pages/SpikePage";
import NovelPage from "./pages/NovelPage";
import ReaderPage from "./pages/ReaderPage";
import SettingsPage from "./pages/SettingsPage";
import StatisticsPage from "./pages/StatisticsPage";
import DownloadToast from "./components/DownloadToast";
import { MenuIcon } from "./components/icons";
import { fetchRecents, type RecentNovel } from "./lib/db";
import { loadUpdateCheckHours } from "./lib/settings";
import { startAutoSync } from "./lib/sync";
import { maybeCheckForUpdates } from "./lib/updates";

type Route =
  | { page: "library" }
  | { page: "browse" }
  | { page: "spike" }
  | { page: "settings" }
  | { page: "statistics" }
  | { page: "novel"; novelId: number }
  | {
      page: "reader";
      novelId: number;
      chapterIdx: number | null;
      segment: number | null;
    };

/** History states are either a route or an "overlay is open" marker —
 * "menu" is the app drawer (handled here); other overlays (e.g. the
 * reader's chapter panel) are handled by their owners' popstate listeners.
 * The marker makes the phone's back button close the overlay first. */
type HistoryState = Route | { overlay: "menu" | "chapters" };

const TABS = [
  { id: "library", label: "Library" },
  { id: "browse", label: "Browse" },
  { id: "statistics", label: "Statistics" },
  { id: "settings", label: "Settings" },
  { id: "spike", label: "Voice Test" },
] as const;

/** Stable identity of a screen — animation re-runs only when this changes. */
const pageKeyOf = (r: Route) =>
  "novelId" in r ? `${r.page}-${r.novelId}` : r.page;

export default function App() {
  const [route, setRoute] = useState<Route>({ page: "library" });
  const [recents, setRecents] = useState<RecentNovel[]>([]);
  const [menuOpen, setMenuOpenState] = useState(false);
  // Direction of the last navigation, for the page slide animation.
  const [navAnim, setNavAnim] = useState<"fwd" | "back">("fwd");

  const routeRef = useRef(route);
  routeRef.current = route;
  const menuOpenRef = useRef(false);
  const setMenuOpen = (v: boolean) => {
    menuOpenRef.current = v;
    setMenuOpenState(v);
  };

  // Routing goes through the browser history so back works everywhere:
  // Android's hardware/gesture back triggers webview goBack() -> popstate,
  // and in-app Back buttons call history.back() so both paths behave
  // identically. Opening the drawer pushes a marker state, so back closes
  // the drawer first.
  const navigate = useCallback((r: Route) => {
    if (pageKeyOf(r) !== pageKeyOf(routeRef.current)) setNavAnim("fwd");
    if (menuOpenRef.current) {
      // The top history entry is the drawer marker — reuse it instead of
      // stacking, so back from the new page skips the open-drawer state.
      window.history.replaceState(r, "");
      setMenuOpen(false);
    } else {
      window.history.pushState(r, "");
    }
    setRoute(r);
  }, []);

  const openMenu = useCallback(() => {
    if (menuOpenRef.current) return;
    window.history.pushState({ overlay: "menu" } satisfies HistoryState, "");
    setMenuOpen(true);
  }, []);

  const closeMenu = useCallback(() => {
    if (menuOpenRef.current) window.history.back();
  }, []);

  useEffect(() => {
    window.history.replaceState({ page: "library" } satisfies Route, "");
    const onPop = (e: PopStateEvent) => {
      const s = e.state as HistoryState | null;
      if (s && "overlay" in s) {
        setMenuOpen(s.overlay === "menu");
        return;
      }
      setMenuOpen(false);
      if (s) {
        if (pageKeyOf(s) !== pageKeyOf(routeRef.current)) setNavAnim("back");
        setRoute(s);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    fetchRecents().then(setRecents).catch(() => {});
  }, [route]);

  // Background new-chapter check on launch, throttled by the Settings
  // interval; results show as "+N new" badges in the Library.
  useEffect(() => {
    void maybeCheckForUpdates(loadUpdateCheckHours());
  }, []);

  // Progress sync on launch/focus (no-op unless enabled in Settings); a
  // merge that moved positions re-fetches recents so the sidebar reflects
  // reading done on the other device.
  useEffect(() => {
    startAutoSync(() => {
      fetchRecents().then(setRecents).catch(() => {});
    });
  }, []);

  // Touch gestures: swipe left from the right edge opens the drawer,
  // swipe right anywhere on the open drawer closes it.
  const touchRef = useRef<{ x: number; y: number; edge: boolean } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchRef.current = {
      x: t.clientX,
      y: t.clientY,
      edge: t.clientX > window.innerWidth - 32,
    };
  };
  const swipeDelta = (e: React.TouchEvent): number | null => {
    const s = touchRef.current;
    touchRef.current = null;
    if (!s) return null;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) < 48 || Math.abs(dy) > Math.abs(dx)) return null;
    return dx;
  };
  const onRootTouchEnd = (e: React.TouchEvent) => {
    const wasEdge = touchRef.current?.edge ?? false;
    const dx = swipeDelta(e);
    if (dx !== null && dx < 0 && wasEdge && !menuOpenRef.current) openMenu();
  };
  const onDrawerTouchEnd = (e: React.TouchEvent) => {
    const dx = swipeDelta(e);
    if (dx !== null && dx > 0) closeMenu();
  };

  const pageKey = pageKeyOf(route);
  const animClass = navAnim === "fwd" ? "page-fwd" : "page-back";

  const navItems = (
    <>
      {TABS.map((t) => (
        <button
          key={t.id}
          onClick={() => {
            if (route.page !== t.id) navigate({ page: t.id });
            else closeMenu();
          }}
          className={`rounded-md px-4 py-2.5 text-left text-[1.15rem] transition-colors ${
            route.page === t.id
              ? "bg-orange-600 text-white"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          }`}
        >
          {t.label}
        </button>
      ))}

      {recents.length > 0 && (
        <div className="mt-auto border-t border-zinc-800 pt-4">
          <div className="mb-1 px-2 text-[0.98rem] font-semibold uppercase tracking-wide text-zinc-600">
            Continue reading
          </div>
          {recents.map((r) => (
            <button
              key={r.id}
              onClick={() =>
                navigate({
                  page: "reader",
                  novelId: r.id,
                  chapterIdx: r.last_read_chapter,
                  segment: r.last_read_segment,
                })
              }
              title={r.title}
              className="w-full truncate rounded-md px-2 py-2 text-left text-[0.98rem] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              {r.title}
            </button>
          ))}
        </div>
      )}
    </>
  );

  // The reader owns the whole window (no sidebar) for distraction-free reading.
  if (route.page === "reader") {
    return (
      <>
        <div key={pageKey} className={animClass}>
          <ReaderPage
            novelId={route.novelId}
            startChapterIdx={route.chapterIdx}
            startSegment={route.segment}
            onBack={() => window.history.back()}
          />
        </div>
        <DownloadToast />
      </>
    );
  }

  // Persistent sidebar on wide viewports; on narrow ones (phones, but also a
  // squeezed desktop window) a top bar whose menu button — or an edge swipe —
  // opens a slide-in panel from the right. Width-driven, not platform-driven.
  return (
    <div
      className="flex h-screen flex-col md:flex-row"
      onTouchStart={onTouchStart}
      onTouchEnd={onRootTouchEnd}
    >
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 py-2 md:hidden">
        <div className="flex items-center gap-2">
          <img src={logo} alt="" className="h-7 w-7" />
          <h1 className="text-lg font-bold tracking-tight">Vates Novel</h1>
        </div>
        <button
          onClick={openMenu}
          className="rounded-md p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          aria-label="Open menu"
        >
          <MenuIcon width={22} height={22} />
        </button>
      </header>

      <nav className="hidden w-[15.6rem] shrink-0 flex-col gap-1 border-r border-zinc-800 bg-zinc-900 p-4 md:flex">
        <div className="mb-4 flex items-center gap-2 px-2">
          <img src={logo} alt="" className="h-8 w-8" />
          <h1 className="text-[1.3rem] font-bold tracking-tight">Vates Novel</h1>
        </div>
        {navItems}
      </nav>

      {menuOpen && (
        <div
          className="fixed inset-0 z-50 md:hidden"
          onClick={closeMenu}
          onTouchStart={onTouchStart}
          onTouchEnd={onDrawerTouchEnd}
        >
          <div className="absolute inset-0 bg-black/60" />
          <nav
            onClick={(e) => e.stopPropagation()}
            className="drawer-panel absolute right-0 top-0 flex h-full w-64 flex-col gap-1 overflow-y-auto border-l border-zinc-800 bg-zinc-900 p-4"
          >
            <div className="mb-3 flex items-center gap-2 px-2">
              <img src={logo} alt="" className="h-7 w-7" />
              <h1 className="text-lg font-bold tracking-tight">Vates Novel</h1>
            </div>
            {navItems}
          </nav>
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div key={pageKey} className={animClass}>
          {route.page === "library" && (
            <LibraryPage
              onOpen={(novelId) => navigate({ page: "novel", novelId })}
            />
          )}
          {route.page === "browse" && <BrowsePage />}
          {route.page === "statistics" && <StatisticsPage />}
          {route.page === "settings" && <SettingsPage />}
          {route.page === "spike" && <SpikePage />}
          {route.page === "novel" && (
            <NovelPage
              novelId={route.novelId}
              onBack={() => window.history.back()}
              onRead={(chapterIdx, segment) =>
                navigate({
                  page: "reader",
                  novelId: route.novelId,
                  chapterIdx,
                  segment,
                })
              }
            />
          )}
        </div>
      </main>
      <DownloadToast />
    </div>
  );
}
