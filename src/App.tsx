import { useEffect, useState } from "react";
import logo from "./assets/logo.png";
import LibraryPage from "./pages/LibraryPage";
import BrowsePage from "./pages/BrowsePage";
import SpikePage from "./pages/SpikePage";
import NovelPage from "./pages/NovelPage";
import ReaderPage from "./pages/ReaderPage";
import SettingsPage from "./pages/SettingsPage";
import StatisticsPage from "./pages/StatisticsPage";
import DownloadToast from "./components/DownloadToast";
import { fetchRecents, type RecentNovel } from "./lib/db";

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

const TABS = [
  { id: "library", label: "Library" },
  { id: "browse", label: "Browse" },
  { id: "statistics", label: "Statistics" },
  { id: "settings", label: "Settings" },
  { id: "spike", label: "Voice Test" },
] as const;

export default function App() {
  const [route, setRoute] = useState<Route>({ page: "library" });
  const [recents, setRecents] = useState<RecentNovel[]>([]);

  useEffect(() => {
    fetchRecents().then(setRecents).catch(() => {});
  }, [route]);

  // The reader owns the whole window (no sidebar) for distraction-free reading.
  if (route.page === "reader") {
    return (
      <>
        <ReaderPage
          novelId={route.novelId}
          startChapterIdx={route.chapterIdx}
          startSegment={route.segment}
          onBack={() => setRoute({ page: "novel", novelId: route.novelId })}
        />
        <DownloadToast />
      </>
    );
  }

  return (
    <div className="flex h-screen">
      <nav className="flex w-[15.6rem] shrink-0 flex-col gap-1 border-r border-zinc-800 bg-zinc-900 p-4">
        <div className="mb-4 flex items-center gap-2 px-2">
          <img src={logo} alt="" className="h-8 w-8" />
          <h1 className="text-[1.3rem] font-bold tracking-tight">Vates Novel</h1>
        </div>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setRoute({ page: t.id })}
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
                  setRoute({
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
      </nav>
      <main className="flex-1 overflow-y-auto p-6">
        {route.page === "library" && (
          <LibraryPage
            onOpen={(novelId) => setRoute({ page: "novel", novelId })}
          />
        )}
        {route.page === "browse" && <BrowsePage />}
        {route.page === "statistics" && <StatisticsPage />}
        {route.page === "settings" && <SettingsPage />}
        {route.page === "spike" && <SpikePage />}
        {route.page === "novel" && (
          <NovelPage
            novelId={route.novelId}
            onBack={() => setRoute({ page: "library" })}
            onRead={(chapterIdx, segment) =>
              setRoute({
                page: "reader",
                novelId: route.novelId,
                chapterIdx,
                segment,
              })
            }
          />
        )}
      </main>
      <DownloadToast />
    </div>
  );
}
