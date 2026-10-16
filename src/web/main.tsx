import { lazy, Suspense, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StartupScreen } from "./components/startup-screen.js";
import { Toaster } from "./components/ui/sonner.js";
import "./style.css";
const MapPage = lazy(() => import("./map-page.js"));
const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: false,
      // Returning to the tab should preserve the current detail/editor view.
      refetchOnWindowFocus: false,
    },
  },
});
function LegacyPanel({ panel }: { panel: string }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("panel", panel);
  return <Navigate to={"/map?" + params.toString()} replace />;
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <>
      <Toaster
        position="top-center"
        visibleToasts={1}
        containerAriaLabel="通知"
      />
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <Routes>
            <Route
              path="/map"
              element={
                <Suspense fallback={<StartupScreen />}>
                  <MapPage />
                </Suspense>
              }
            />
            {["archive", "settings"].map((panel) => (
              <Route
                key={panel}
                path={"/" + panel}
                element={<LegacyPanel panel={panel} />}
              />
            ))}
            <Route path="*" element={<Navigate to="/map" replace />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </>
  </StrictMode>,
);
